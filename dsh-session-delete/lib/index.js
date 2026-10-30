// @local/dsh-session-delete —— 宿主半边
//
// 基于 dsh-archive-manager 的删除会话逻辑精简而来。
//
// 删除管线：
//   1. 验证会话 ID
//   2. 有界超时等待 agent 终止
//   3. 拒绝仍然活跃的会话
//   4. 删除持久化日志目录（含 Windows 重试）
//   5. 从工作区 detach（幂等）+ 若在归档集合中则一并清理
//
// 归档不是前置条件：未归档的会话也能直接删。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { rm } from 'node:fs/promises';
import { dirname, parse, resolve } from 'node:path';

export const name = 'session-delete';

/*
 * deleteSession 会直接读这些服务；Cordis 对未声明的服务访问会抛
 * `cannot get property "X" without inject`，因此必须全部声明。
 * 与宿主自带的 dsh-client-ui-deliverables 的
 * inject: ['agents', 'sessions', 'workspaceRegistry'] 保持一致。
 * webServer 走下面的 ctx.inject(['webServer'], ...)，不在这里声明。
 */
export const inject = ['tools', 'agents', 'sessions', 'workspaceRegistry', 'sessionPersistence'];

/* ───────────────────────── 配置 ───────────────────────── */

function normalizeConfig(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  return {
    routePrefix: typeof r.routePrefix === 'string' && r.routePrefix.trim()
      ? r.routePrefix.trim()
      : '/api/session-delete',
  };
}

/* ───────────────────────── HTTP 路由 ───────────────────────── */

function readBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      size += buf.length;
      if (size > limit) { reject(new Error(`请求体过大（上限 ${Math.round(limit / 1024 / 1024)} MB）`)); req.destroy(); return; }
      chunks.push(buf);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(new Error('请求体不是合法 JSON')); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
  });
  res.end(JSON.stringify(body));
}

function isLoopback(req) {
  const addr = req.socket?.remoteAddress ?? '';
  const host = String(req.headers.host ?? '');
  const hostname = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  const loopbackAddr = addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
  const loopbackHost = hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
  return loopbackAddr && loopbackHost;
}

function mountWebUi(ctx, config, logger) {
  ctx.inject(['webServer'], (sctx) => {
    sctx.effect(() => {
      const prefix = config.routePrefix.replace(/\/+$/, '');
      const guard = (req, res) => {
        if (isLoopback(req)) return true;
        sendJson(res, 403, { ok: false, message: '仅允许本机访问' });
        return false;
      };
      const allow = (req, res, methods) => {
        const method = req.method ?? '';
        if (methods.includes(method)) return true;
        sendJson(res, 405, { ok: false, message: `method not allowed: ${method}` });
        return false;
      };
      const dispose = [];
      const route = (suffix, methods, handler) => {
        dispose.push(sctx.webServer.register({
          kind: 'exact',
          path: `${prefix}/${suffix}`,
          handler: async (req, res) => {
            if (!guard(req, res) || !allow(req, res, methods)) return;
            try { sendJson(res, 200, await handler(req)); }
            catch (error) { sendJson(res, 400, { ok: false, message: error.message }); }
          },
        }));
      };
      route('delete', ['POST'], async (req) => {
        const body = await readBody(req);
        return deleteSession(ctx, body.sessionId);
      });
      logger.info(`session-delete 路由已挂载：${prefix}/*`);
      return () => { for (const off of dispose) { try { off(); } catch {} } };
    }, 'session-delete: http routes');
  });
}

/* ───────────────────────── 删除逻辑 ───────────────────────── */

const REMOVE_RETRY_DELAYS_MS = [0, 120, 300, 600];
const REMOVE_RETRYABLE_CODES = new Set(['EBUSY', 'EPERM', 'EACCES', 'UNKNOWN', 'ETXTBSY']);

/** DSH 数据根目录，与 dsh-mcp-manager 保持一致。 */
function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

/**
 * `ctx.sessionPersistence` 是抽象 seam，`findLog` 只由具体后端实现，
 * 且它按后端自己的 root 解析——和会话实际落盘的 <DSH_HOME>/sessions
 * 不一定是同一个地方。所以这里不把它当作唯一依据：
 *   1. 先用 findLog 问后端要路径（拿到就用）
 *   2. 再按 <DSH_HOME>/sessions/<project>/<sessionId> 的磁盘布局兜底枚举
 * 两个来源合并去重，确保不会因为后端解析不到就静默跳过删除。
 */
function sessionsRoot() {
  return path.join(dshHome(), 'sessions');
}

/** 按磁盘布局找出该会话所有可能的目录。 */
function scanSessionDirs(sessionId) {
  const root = sessionsRoot();
  const found = [];
  let projects;
  try {
    projects = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const candidate = path.join(root, project.name, sessionId);
    try {
      if (fs.statSync(candidate).isDirectory()) found.push(candidate);
    } catch { /* 不存在就跳过 */ }
  }
  return found;
}

async function findLogDirs(ctx, sessionId) {
  const dirs = new Set();

  // 1) 问后端要（可能失败或返回 null）
  const persistence = ctx.sessionPersistence;
  if (persistence && typeof persistence.findLog === 'function') {
    try {
      const logPath = await persistence.findLog(sessionId);
      if (typeof logPath === 'string' && logPath !== '') {
        const dir = resolve(dirname(logPath));
        // 拒绝盘符根这种危险值
        if (parse(dir).root !== dir) dirs.add(dir);
      }
    } catch { /* 交给磁盘扫描兜底 */ }
  }

  // 2) 按磁盘布局兜底
  for (const dir of scanSessionDirs(sessionId)) dirs.add(resolve(dir));

  return [...dirs];
}

async function removeLogDirs(ctx, sessionId) {
  const dirs = await findLogDirs(ctx, sessionId);
  if (!dirs.length) return true; // 本来就没有目录，视作已完成

  let allRemoved = true;
  for (const dir of dirs) {
    let done = false;
    for (let attempt = 0; attempt < REMOVE_RETRY_DELAYS_MS.length && !done; attempt++) {
      try {
        await rm(dir, { recursive: true, force: true });
        done = true;
      } catch (error) {
        const code = error?.code;
        const retriable = code && REMOVE_RETRYABLE_CODES.has(code);
        if (!retriable || attempt === REMOVE_RETRY_DELAYS_MS.length - 1) {
          allRemoved = false;
        } else {
          await new Promise((r) => setTimeout(r, REMOVE_RETRY_DELAYS_MS[attempt + 1]));
        }
      }
    }
    // 复核：删完必须真的不在
    if (done && fs.existsSync(dir)) allRemoved = false;
  }
  return allRemoved;
}

async function deleteSession(ctx, sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') return { ok: false, message: '会话ID不能为空' };

  const registry = ctx.workspaceRegistry;
  const archivedIds = registry?.state?.archivedSessionIds;
  const isArchived = Array.isArray(archivedIds) && archivedIds.includes(sessionId);

  /*
   * 归档不再是前置条件：未归档的会话也能直接删。
   * 归档只决定要不要顺带清理 archivedSessionIds，不影响删除本身。
   */

  // 检查是否有活跃 agent
  const agent = ctx.agents?.get?.(sessionId);
  if (agent) {
    // 等待 agent 终止（有界超时）
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  // 检查会话是否还活着（删自己所在的会话会先 detach，故不阻断）
  if (ctx.sessions?.get?.(sessionId) !== undefined) {
    return { ok: false, message: '会话仍然活跃，无法删除' };
  }

  // 删除日志目录（后端解析 + 磁盘布局双重定位，并复核结果）
  const removed = await removeLogDirs(ctx, sessionId);
  if (!removed) return { ok: false, message: '日志目录删除失败' };

  // 从工作区 detach（幂等：不是成员时不动）
  if (registry?.entities && typeof registry.entities.values === 'function') {
    for (const entity of registry.entities.values()) {
      try {
        if (typeof entity.detachSession === 'function') await entity.detachSession(sessionId);
      } catch {}
    }
  }
  // 仅当它确实在归档集合里时才清理该记录
  if (isArchived && registry?.enqueueOperation) {
    await registry.enqueueOperation(async () => {
      if (registry.state && Array.isArray(registry.state.archivedSessionIds)) {
        registry.state.archivedSessionIds = registry.state.archivedSessionIds.filter((id) => id !== sessionId);
      }
    });
  }

  return { ok: true, message: `已删除会话：${sessionId}` };
}

/* ───────────────────────── 工具输出 ───────────────────────── */

const RESULT_SCHEMA = {
  type: 'object',
  properties: { ok: { type: 'boolean' }, message: { type: 'string' } },
  required: ['ok', 'message'],
  additionalProperties: true,
};

function textOutput(lines) {
  return {
    schema: RESULT_SCHEMA,
    render(_args, value) {
      const body = [value.message, ...lines(value)].filter(Boolean).join('\n');
      return [{ type: 'text', text: body }];
    },
  };
}

const actionOutput = textOutput(() => []);

/* ───────────────────────── 插件入口 ───────────────────────── */

export async function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig);
  const logger = typeof ctx.logger === 'function' ? ctx.logger('session-delete') : (ctx.logger ?? console);

  // 注册对话工具
  ctx.tools.register({
    name: 'session_manager_delete',
    description: '永久删除指定的会话，清理其日志目录、工作区归属和 agent。无需先归档；会话必须处于非活跃状态。',
    parameters: {
      type: 'object',
      properties: { sessionId: { type: 'string', description: '要删除的会话 ID' } },
      required: ['sessionId'],
      additionalProperties: false,
    },
    output: actionOutput,
    timeoutMs: 60_000,
    async execute(args) { return deleteSession(ctx, args?.sessionId); },
  });

  try { mountWebUi(ctx, config, logger); }
  catch (error) { logger.warn(`session-delete 路由挂载失败：${error.message}`); }

  logger.info('session-delete 已加载');
}

export default { name, inject, apply };