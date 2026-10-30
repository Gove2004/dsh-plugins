/**
 * @local/dsh-mcp-manager —— 宿主半边（Host half）
 *
 * 设计原则：**只做管道，不做货架**。
 *   - 没有内置目录、没有远程 registry、没有「推荐连接器」列表
 *   - 唯一的真相来源是用户自己填写的 servers 数组
 *   - 每条记录被投射成一条 `@deepseek-ai/dsh-mcp-client` 条目
 *
 * 两个入口共用同一套 core：
 *   - 对话工具：mcp_list / mcp_add / mcp_remove / mcp_toggle
 *   - 图形界面：左侧栏入口 + 同源 HTTP 路由（<routePrefix>/list|add|remove|toggle）
 *
 * 存储：`<DSH_HOME>/storages/<storageFile>`，纯 JSON，可手工编辑。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const name = 'mcp-manager';

/** loader 用于动态增删 mcp-client 条目；tools 用于注册管理工具。 */
export const inject = ['tools', 'loader'];

/*
 * 不导出 schemastery 的 Config：本插件是 link 进 profile 的，Node 按真实路径解析
 * 裸导入时会从 E:\...\dsh-mcp-manager\ 往上找 node_modules，而本仓库刻意不带
 * node_modules（依赖由宿主 profile 提供），因此 `@deepseek-ai/schemastery`
 * 解析失败、插件激活报 ERR_MODULE_NOT_FOUND。
 * 这里改为运行时归一化，缺字段一律给默认值。
 */
function normalizeConfig(input) {
  const raw = input && typeof input === 'object' ? input : {};
  const text = (value, fallback) => (typeof value === 'string' && value.trim() ? value.trim() : fallback);
  return {
    /** 投射出的 loader 条目 id 前缀：<entryPrefix>-<serverName>。 */
    entryPrefix: text(raw.entryPrefix, 'mcp'),
    /** 存储文件名，放在 <DSH_HOME>/storages/ 下。 */
    storageFile: text(raw.storageFile, 'mcp_manager.json'),
    /** HTTP 路由前缀（界面数据源）。 */
    routePrefix: text(raw.routePrefix, '/api/mcp-manager'),
  };
}

const MCP_CLIENT = '@deepseek-ai/dsh-mcp-client';
const SERVER_NAME_RE = /^[A-Za-z0-9_-]{1,32}$/;

/* ────────────────────────────── 存储 ────────────────────────────── */

function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

function storagePath(config) {
  return path.join(dshHome(), 'storages', config.storageFile);
}

function readServers(config) {
  const file = storagePath(config);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`MCP 配置文件不是合法 JSON：${file}`);
  }
  const list = Array.isArray(parsed) ? parsed : parsed?.servers;
  if (!Array.isArray(list)) throw new Error(`MCP 配置文件缺少 servers 数组：${file}`);
  return list.filter((r) => r && typeof r === 'object' && typeof r.serverName === 'string');
}

function writeServers(config, servers) {
  const file = storagePath(config);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = `${JSON.stringify({ version: 1, servers }, null, 2)}\n`;
  // 先写临时文件再原子替换，避免半截文件
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, body, 'utf8');
  fs.renameSync(tmp, file);
  return file;
}

/* ───────────────────────── 记录 → loader 条目 ───────────────────────── */

function entryIdFor(config, record) {
  return `${config.entryPrefix}-${record.serverName}`;
}

/** 把一条存储记录翻译成 @deepseek-ai/dsh-mcp-client 的 config。 */
function buildEntryConfig(record) {
  if (record.transport === 'stdio') {
    const entry = {
      transport: 'stdio',
      serverName: record.serverName,
      command: record.command,
    };
    if (record.args?.length) entry.args = record.args;
    if (record.env && Object.keys(record.env).length) entry.env = record.env;
    if (record.cwd) entry.cwd = record.cwd;
    return entry;
  }
  const entry = {
    transport: 'streamable-http',
    serverName: record.serverName,
    url: record.url,
  };
  if (record.headers && Object.keys(record.headers).length) entry.headers = record.headers;
  return entry;
}

function hasEntry(ctx, id) {
  try {
    ctx.loader.resolve(id);
    return true;
  } catch {
    return false;
  }
}

/**
 * 幂等投射：条目存在则更新，不存在则创建。
 * serverName 不变 → 工具名前缀不变。传输方式变了就整体替换 config。
 */
async function provision(ctx, config, record) {
  const id = entryIdFor(config, record);
  const entryConfig = buildEntryConfig(record);
  const disabled = record.enabled === false;
  if (hasEntry(ctx, id)) {
    const previous = ctx.loader.resolve(id)?.options?.config ?? {};
    const next = previous.transport && previous.transport !== entryConfig.transport
      ? entryConfig
      : { ...previous, ...entryConfig };
    await ctx.loader.update(id, { config: next, disabled });
  } else {
    await ctx.loader.create({ id, name: MCP_CLIENT, config: entryConfig, disabled });
  }
  return id;
}

async function unprovision(ctx, config, record) {
  const id = entryIdFor(config, record);
  if (!hasEntry(ctx, id)) return id;
  try {
    await ctx.loader.remove(id);
  } catch (error) {
    // 条目已经坏了也不该拦住删除配置
    if (!/no such|not found|unknown/i.test(String(error?.message ?? ''))) throw error;
  }
  return id;
}

/* ───────────────────────────── 校验 ───────────────────────────── */

function validateRecord(input) {
  const serverName = String(input.serverName ?? '').trim();
  if (!SERVER_NAME_RE.test(serverName)) {
    throw new Error('serverName 必须是 1-32 位的字母/数字/下划线/连字符，它决定工具名前缀 mcp__<serverName>__*');
  }
  const transport = input.transport === 'stdio'
    ? 'stdio'
    : input.transport === 'streamable-http'
      ? 'streamable-http'
      : null;
  if (!transport) throw new Error('transport 必须是 stdio 或 streamable-http');

  const record = { serverName, transport, enabled: input.enabled !== false };
  if (input.note) record.note = String(input.note);

  if (transport === 'stdio') {
    const command = String(input.command ?? '').trim();
    if (!command) throw new Error('stdio 传输必须提供 command');
    record.command = command;
    if (Array.isArray(input.args)) record.args = input.args.map(String);
    if (input.env && typeof input.env === 'object' && !Array.isArray(input.env)) {
      record.env = { ...input.env };
    }
    if (input.cwd) record.cwd = String(input.cwd);
  } else {
    const url = String(input.url ?? '').trim();
    if (!url) throw new Error('streamable-http 传输必须提供 url');
    if (!/^https?:\/\//i.test(url)) throw new Error('url 必须以 http:// 或 https:// 开头');
    record.url = url;
    if (input.headers && typeof input.headers === 'object' && !Array.isArray(input.headers)) {
      record.headers = { ...input.headers };
    }
  }
  return record;
}

/* ─────────────── 核心操作（对话工具与图形界面共用同一套） ─────────────── */

function createCore(ctx, config) {
  const list = () =>
    readServers(config).map((r) => ({
      ...r,
      // 「已加载」必须同时满足：启用 + loader 条目存在。停用的条目仍在 loader 里，但不该算已加载。
      live: r.enabled !== false && hasEntry(ctx, entryIdFor(config, r)),
    }));

  const add = async (input) => {
    const record = validateRecord(input ?? {});
    const servers = readServers(config);
    const index = servers.findIndex((r) => r.serverName === record.serverName);
    const existed = index >= 0;
    if (existed) servers[index] = record;
    else servers.push(record);
    await provision(ctx, config, record);
    const file = writeServers(config, servers);
    return {
      ok: true,
      message: `${existed ? '已更新' : '已添加'} MCP 服务器 ${record.serverName}（${record.transport}）。配置：${file}`,
      servers: list(),
    };
  };

  const remove = async (serverNameRaw) => {
    const serverName = String(serverNameRaw ?? '').trim();
    const servers = readServers(config);
    const index = servers.findIndex((r) => r.serverName === serverName);
    if (index < 0) return { ok: false, message: `没有名为 ${serverName} 的 MCP 服务器。`, servers: list() };
    const [record] = servers.splice(index, 1);
    await unprovision(ctx, config, record);
    writeServers(config, servers);
    return { ok: true, message: `已删除 MCP 服务器 ${serverName}，其工具已卸载。`, servers: list() };
  };

  const toggle = async (serverNameRaw, enabledRaw) => {
    const serverName = String(serverNameRaw ?? '').trim();
    const enabled = enabledRaw !== false;
    const servers = readServers(config);
    const record = servers.find((r) => r.serverName === serverName);
    if (!record) return { ok: false, message: `没有名为 ${serverName} 的 MCP 服务器。`, servers: list() };
    record.enabled = enabled;
    await provision(ctx, config, record);
    writeServers(config, servers);
    return { ok: true, message: `${serverName} 已${enabled ? '启用' : '停用'}。`, servers: list() };
  };

  return { list, add, remove, toggle };
}

/* ─────────────────────────── 输出渲染 ─────────────────────────── */

const RESULT_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    message: { type: 'string' },
  },
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

const listOutput = textOutput((value) => {
  const servers = value.servers ?? [];
  if (!servers.length) return ['（没有任何 MCP 服务器）'];
  return servers.map((s) => {
    const state = s.enabled ? '启用' : '停用';
    const live = s.live ? '已加载' : '未加载';
    const target = s.transport === 'stdio'
      ? `${s.command} ${(s.args ?? []).join(' ')}`.trim()
      : s.url;
    const note = s.note ? ` · ${s.note}` : '';
    return `- ${s.serverName} [${s.transport}] ${state}/${live} · ${target}${note}`;
  });
});

const actionOutput = textOutput(() => []);

/* ───────────────────────────── HTTP 路由 ───────────────────────────── */

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1_000_000) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
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

/** 只接受本机回环请求，避免任意网页 CSRF 到本地面板。 */
function isLoopback(req) {
  const addr = req.socket?.remoteAddress ?? '';
  const host = String(req.headers.host ?? '');
  const hostname = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  const loopbackAddr = addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
  const loopbackHost = hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
  return loopbackAddr && loopbackHost;
}

function mountWebUi(ctx, config, core, logger) {
  ctx.inject(['webServer'], (sctx) => {
    sctx.effect(() => {
      const prefix = config.routePrefix.replace(/\/+$/, '');

      /** 回环守卫：不是本机请求就直接 403。 */
      const guard = (req, res) => {
        if (isLoopback(req)) return true;
        sendJson(res, 403, { ok: false, message: '仅允许本机访问' });
        return false;
      };
      /** 读接口允许 GET/POST，写接口只允许 POST。 */
      const allow = (req, res, methods) => {
        const method = req.method ?? '';
        if (methods.includes(method)) return true;
        sendJson(res, 405, { ok: false, message: `method not allowed: ${method}` });
        return false;
      };

      const dispose = [];

      dispose.push(sctx.webServer.register({
        kind: 'exact',
        path: `${prefix}/list`,
        handler: (req, res) => {
          if (!guard(req, res) || !allow(req, res, ['GET', 'POST'])) return;
          try {
            const servers = core.list();
            sendJson(res, 200, {
              ok: true,
              message: servers.length ? `共 ${servers.length} 个 MCP 服务器` : '还没有配置任何 MCP 服务器',
              servers,
            });
          } catch (error) {
            sendJson(res, 500, { ok: false, message: error.message });
          }
        },
      }));

      dispose.push(sctx.webServer.register({
        kind: 'exact',
        path: `${prefix}/add`,
        handler: async (req, res) => {
          if (!guard(req, res) || !allow(req, res, ['POST'])) return;
          try {
            const result = await core.add(await readBody(req));
            sendJson(res, 200, result);
          } catch (error) {
            sendJson(res, 400, { ok: false, message: error.message });
          }
        },
      }));

      dispose.push(sctx.webServer.register({
        kind: 'exact',
        path: `${prefix}/remove`,
        handler: async (req, res) => {
          if (!guard(req, res) || !allow(req, res, ['POST'])) return;
          try {
            const body = await readBody(req);
            sendJson(res, 200, await core.remove(body.serverName));
          } catch (error) {
            sendJson(res, 400, { ok: false, message: error.message });
          }
        },
      }));

      dispose.push(sctx.webServer.register({
        kind: 'exact',
        path: `${prefix}/toggle`,
        handler: async (req, res) => {
          if (!guard(req, res) || !allow(req, res, ['POST'])) return;
          try {
            const body = await readBody(req);
            sendJson(res, 200, await core.toggle(body.serverName, body.enabled));
          } catch (error) {
            sendJson(res, 400, { ok: false, message: error.message });
          }
        },
      }));

      logger.info(`mcp-manager 路由已挂载：${prefix}/*`);
      return () => {
        for (const off of dispose) {
          try {
            off();
          } catch {
            /* 卸载阶段忽略 */
          }
        }
      };
    }, 'mcp-manager: http routes');
  });
}

/* ───────────────────────────── 插件入口 ───────────────────────────── */

export async function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig);
  const logger = typeof ctx.logger === 'function' ? ctx.logger('mcp-manager') : (ctx.logger ?? console);
  const core = createCore(ctx, config);
  const disposers = [];

  /* 启动时把已配置的服务器全部投射成 mcp-client 条目（停用的保持停用） */
  let initial = [];
  try {
    initial = readServers(config);
  } catch (error) {
    logger.warn(`读取 MCP 配置失败：${error.message}`);
  }
  for (const record of initial) {
    try {
      await provision(ctx, config, record);
    } catch (error) {
      logger.warn(`投射 MCP 服务器 ${record.serverName} 失败：${error.message}`);
    }
  }
  if (initial.length) logger.info(`mcp-manager 已加载 ${initial.length} 个 MCP 服务器`);

  const register = (def) => {
    disposers.push(ctx.tools.register(def));
  };

  /* ── 列出 ── */
  register({
    name: 'mcp_list',
    description:
      '列出所有已配置的 MCP 服务器（名称、传输方式、启停状态、是否已加载、目标地址、备注）。'
      + '这是本机唯一的 MCP 清单，不含任何在线目录或推荐列表。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: listOutput,
    async execute() {
      const servers = core.list();
      return {
        ok: true,
        message: servers.length ? `共 ${servers.length} 个 MCP 服务器：` : '还没有配置任何 MCP 服务器。',
        servers,
      };
    },
  });

  /* ── 新增 / 更新 ── */
  register({
    name: 'mcp_add',
    description:
      '新增或更新一个 MCP 服务器（按 serverName 幂等 upsert），写入配置并立即生效。'
      + 'stdio 需要 command（可选 args/env/cwd）；远端需要 transport=streamable-http 和 url（可选 headers）。',
    parameters: {
      type: 'object',
      properties: {
        serverName: { type: 'string', description: '服务器名，1-32 位字母/数字/下划线/连字符；决定工具名前缀 mcp__<serverName>__*' },
        transport: { type: 'string', enum: ['stdio', 'streamable-http'], description: '本地程序用 stdio，远端服务用 streamable-http' },
        command: { type: 'string', description: 'stdio：可执行文件，如 npx / node / uvx' },
        args: { type: 'array', items: { type: 'string' }, description: 'stdio：参数列表' },
        env: { type: 'object', additionalProperties: { type: 'string' }, description: 'stdio：额外环境变量' },
        cwd: { type: 'string', description: 'stdio：工作目录' },
        url: { type: 'string', description: 'streamable-http：端点 URL' },
        headers: { type: 'object', additionalProperties: { type: 'string' }, description: 'streamable-http：额外请求头' },
        note: { type: 'string', description: '备注，方便日后辨认' },
        enabled: { type: 'boolean', description: '是否启用，默认 true' },
      },
      required: ['serverName', 'transport'],
      additionalProperties: false,
    },
    output: actionOutput,
    timeoutMs: 60_000,
    async execute(args) {
      return core.add(args ?? {});
    },
  });

  /* ── 删除 ── */
  register({
    name: 'mcp_remove',
    description: '删除一个 MCP 服务器：从配置中移除，并卸载对应的 mcp-client 条目及其工具。',
    parameters: {
      type: 'object',
      properties: {
        serverName: { type: 'string', description: '要删除的服务器名' },
      },
      required: ['serverName'],
      additionalProperties: false,
    },
    output: actionOutput,
    timeoutMs: 60_000,
    async execute(args) {
      return core.remove(args?.serverName);
    },
  });

  /* ── 启停 ── */
  register({
    name: 'mcp_toggle',
    description: '启用或停用一个已配置的 MCP 服务器，不删除配置。停用后其工具立即从模型工具列表中消失。',
    parameters: {
      type: 'object',
      properties: {
        serverName: { type: 'string', description: '服务器名' },
        enabled: { type: 'boolean', description: 'true 启用 / false 停用' },
      },
      required: ['serverName', 'enabled'],
      additionalProperties: false,
    },
    output: actionOutput,
    timeoutMs: 60_000,
    async execute(args) {
      return core.toggle(args?.serverName, args?.enabled);
    },
  });

  /* ── HTTP 路由（左侧栏界面用它取数据） ── */
  try {
    mountWebUi(ctx, config, core, logger);
  } catch (error) {
    logger.warn(`mcp-manager 路由挂载失败：${error.message}`);
  }

  /* 卸载时把本插件注册的工具一并撤掉 */
  ctx.effect(() => () => {
    for (const off of disposers) {
      try {
        off();
      } catch {
        /* 卸载阶段忽略 */
      }
    }
  });
}
