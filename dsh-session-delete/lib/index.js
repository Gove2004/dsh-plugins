// @local/dsh-session-delete —— 宿主半边
//
// 基于 dsh-archive-manager 的删除会话逻辑精简而来。
// 只保留「删除已归档会话」的核心功能。
//
// 删除管线：
//   1. 验证会话 ID
//   2. 检查是否已归档
//   3. 有界超时等待 agent 终止
//   4. 删除持久化日志目录（含 Windows 重试）
//   5. 从工作区 detach + 清理归档记录

import { rm } from 'node:fs/promises';
import { dirname, parse, resolve } from 'node:path';

export const name = 'session-delete';
export const inject = ['tools'];

/* ───────────────────────── 配置 ───────────────────────── */

function normalizeConfig(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  return {
    routePrefix: typeof r.routePrefix === 'string' && r.routePrefix.trim()
      ? r.routePrefix.trim()
      : '/api/session-manager',
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

async function findLogDir(ctx, sessionId) {
  const persistence = ctx.sessionPersistence;
  if (!persistence || typeof persistence.findLog !== 'function') return null;
  try {
    const logPath = await persistence.findLog(sessionId);
    if (typeof logPath !== 'string' || logPath === '') return null;
    const dir = resolve(dirname(logPath));
    if (parse(dir).root === dir) return null;
    return dir;
  } catch { return null; }
}

async function removeLogDir(ctx, sessionId) {
  const dir = await findLogDir(ctx, sessionId);
  if (!dir) return true;
  for (let attempt = 0; attempt < REMOVE_RETRY_DELAYS_MS.length; attempt++) {
    try {
      await rm(dir, { recursive: true, force: true });
      return true;
    } catch (error) {
      const code = error?.code;
      const retriable = code && REMOVE_RETRYABLE_CODES.has(code);
      if (!retriable || attempt === REMOVE_RETRY_DELAYS_MS.length - 1) return false;
      await new Promise((r) => setTimeout(r, REMOVE_RETRY_DELAYS_MS[attempt + 1]));
    }
  }
  return false;
}

async function deleteSession(ctx, sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') return { ok: false, message: '会话ID不能为空' };

  // 检查是否已归档
  const registry = ctx.workspaceRegistry;
  const archivedIds = registry?.state?.archivedSessionIds;
  const isArchived = Array.isArray(archivedIds) && archivedIds.includes(sessionId);
  if (!isArchived) return { ok: false, message: '只能删除已归档的会话' };

  // 检查是否有活跃 agent
  const agent = ctx.agents?.get?.(sessionId);
  if (agent) {
    // 等待 agent 终止（有界超时）
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  // 检查会话是否还活着
  if (ctx.sessions?.get?.(sessionId) !== undefined) {
    return { ok: false, message: '会话仍然活跃，无法删除' };
  }

  // 删除日志目录
  const removed = await removeLogDir(ctx, sessionId);
  if (!removed) return { ok: false, message: '日志目录删除失败' };

  // 从工作区 detach + 清理归档记录
  if (registry?.entities && typeof registry.entities.values === 'function') {
    for (const entity of registry.entities.values()) {
      try {
        if (typeof entity.detachSession === 'function') await entity.detachSession(sessionId);
      } catch {}
    }
  }
  if (registry?.enqueueOperation) {
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
    description: '删除指定的已归档会话，清理相关存储文件和 agent。会话必须先归档才能删除。',
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