/**
 * 拖拽导入（POST /api/skill-manager/import）的回归测试。
 *
 * 做法：用桩 ctx 把插件 `apply` 起来，拿到真实注册的 HTTP 路由处理函数，
 * 然后直接喂假 req/res。不启动 DSH、不碰真实 <DSH_HOME>（技能根指向临时目录）。
 *
 *   node test/import.test.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const mod = await import(pathToFileURL(path.join(here, '..', 'lib', 'index.js')).href);

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'skm-import-'));
const skillsDir = path.join(tmpRoot, 'skills');
const cwd = path.join(tmpRoot, 'ws');
fs.mkdirSync(skillsDir, { recursive: true });
fs.mkdirSync(cwd, { recursive: true });

/* ── 桩 ctx ── */

const routes = new Map();
const tools = [];
const disposers = [];

const ctx = {
  effect(fn) {
    const d = fn();
    if (typeof d === 'function') disposers.push(d);
    return d;
  },
  get(name) {
    return name === 'workingDirectory' ? { defaultDirectory: cwd } : undefined;
  },
  inject(_names, cb) {
    return cb(ctx);
  },
  logger: { info() {}, warn() {}, error() {}, debug() {} },
  tools: {
    register(def) {
      tools.push(def);
      return () => {};
    },
  },
  skills: {
    registerProvider() {
      return () => {};
    },
    async list() { return []; },
    async snapshot() { return { skills: [], complete: true }; },
    async get() { return undefined; },
  },
  webServer: {
    register(entry) {
      routes.set(entry.path, entry.handler);
      return () => {};
    },
  },
};

await mod.apply(ctx, { routePrefix: '/api/skill-manager', skillRoot: skillsDir, projectRoot: false });

/* ── 假 req / res ── */

function makeReq(body, remote = '127.0.0.1') {
  const req = Readable.from([Buffer.from(JSON.stringify(body), 'utf8')]);
  req.method = 'POST';
  req.headers = { host: '127.0.0.1:1234' };
  req.socket = { remoteAddress: remote };
  return req;
}

function makeRes() {
  const out = { status: 0, body: null };
  return {
    out,
    writeHead(status) { out.status = status; },
    end(text) {
      try { out.body = JSON.parse(text); } catch { out.body = text; }
    },
  };
}

const handler = routes.get('/api/skill-manager/import');

/* ── 断言 ── */

const results = [];
function check(label, ok, detail) {
  results.push({ label, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${detail}`}`);
}

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

async function post(body, remote) {
  const res = makeRes();
  await handler(makeReq(body, remote), res);
  return res.out;
}

const SKILL_MD = [
  '---',
  'name: pdf-report',
  'description: 把 PDF 整理成结论摘要',
  'whenToUse: 用户丢来一份 PDF',
  '---',
  '',
  '# PDF Report',
  '',
  '正文',
].join('\n');

const withName = (name) => SKILL_MD.replace('name: pdf-report', `name: ${name}`);

try {
  /* 1. 目录导入：SKILL.md + 资源文件 + 二进制 */
  let r = await post({
    name: 'pdf-report',
    kind: 'dir',
    files: [
      { path: 'SKILL.md', data: b64(SKILL_MD) },
      { path: 'scripts/run.py', data: b64('print(1)\n') },
      { path: 'references/notes.md', data: b64('# notes\n') },
      { path: 'assets/logo.bin', data: Buffer.from([0, 1, 2, 255]).toString('base64') },
    ],
  });
  const dir = path.join(skillsDir, 'pdf-report');
  check('目录导入成功', r.status === 200 && r.body?.ok === true, JSON.stringify(r));
  check('SKILL.md 落盘', fs.existsSync(path.join(dir, 'SKILL.md')));
  check('scripts/run.py 落盘', fs.readFileSync(path.join(dir, 'scripts', 'run.py'), 'utf8') === 'print(1)\n');
  check('references/notes.md 落盘', fs.existsSync(path.join(dir, 'references', 'notes.md')));
  check('二进制原样还原', fs.readFileSync(path.join(dir, 'assets', 'logo.bin')).equals(Buffer.from([0, 1, 2, 255])));
  check('临时目录已清理', fs.readdirSync(skillsDir).every((n) => !n.startsWith('.import-')));

  /* 2. 以 frontmatter.name 命名，不取目录名 */
  r = await post({ name: '随便什么名字', kind: 'dir', files: [{ path: 'SKILL.md', data: b64(withName('other-name')) }] });
  check('以 frontmatter.name 命名目录', r.status === 200 && fs.existsSync(path.join(skillsDir, 'other-name', 'SKILL.md')), JSON.stringify(r));

  /* 3. 只含 SKILL.md 的目录仍按目录导入（不能退化成平铺） */
  r = await post({ name: 'solo', kind: 'dir', files: [{ path: 'SKILL.md', data: b64(withName('solo')) }] });
  check('单文件目录仍按目录导入', r.status === 200
    && fs.existsSync(path.join(skillsDir, 'solo', 'SKILL.md'))
    && !fs.existsSync(path.join(skillsDir, 'solo.md')), JSON.stringify(r));

  /* 4. 路径穿越与非法名 */
  const evilPaths = ['../evil.txt', '../../evil.txt', 'a/../../evil.txt', 'C:/evil.txt', '/etc/passwd', 'scripts/..', 'con.md', 'nul', 'a:b.txt', 'trail.'];
  for (const evil of evilPaths) {
    r = await post({ name: 'evil', kind: 'dir', files: [{ path: 'SKILL.md', data: b64(withName('evil')) }, { path: evil, data: b64('x') }] });
    check(`拒绝非法路径 ${evil}`, r.status === 400 && r.body?.ok === false, JSON.stringify(r));
  }
  check('穿越文件没有落盘', !fs.existsSync(path.join(tmpRoot, 'evil.txt')) && !fs.existsSync(path.join(skillsDir, 'evil')));

  /* 5. kind 与内容不符 */
  r = await post({ name: 'liar', kind: 'flat', files: [{ path: 'a/SKILL.md', data: b64(SKILL_MD) }] });
  check('平铺却给了嵌套路径被拒', r.status === 400, JSON.stringify(r));
  r = await post({ name: 'liar', kind: 'flat', files: [{ path: 'a.txt', data: b64('x') }] });
  check('平铺却不是 .md 被拒', r.status === 400, JSON.stringify(r));

  /* 6. 结构不合法 */
  r = await post({ name: 'no-skill', kind: 'dir', files: [{ path: 'readme.md', data: b64('# hi') }] });
  check('目录缺 SKILL.md 被拒', r.status === 400 && /SKILL\.md/.test(r.body?.message ?? ''), JSON.stringify(r));
  r = await post({ name: 'pdf-report', kind: 'dir', files: [{ path: 'SKILL.md', data: b64(SKILL_MD) }] });
  check('重名被拒', r.status === 400 && /已存在/.test(r.body?.message ?? ''), JSON.stringify(r));
  r = await post({ name: 'empty', kind: 'dir', files: [] });
  check('空文件清单被拒', r.status === 400, JSON.stringify(r));

  /* 7. frontmatter 校验 */
  r = await post({ name: 'BadCase', kind: 'dir', files: [{ path: 'SKILL.md', data: b64(withName('BadCase')) }] });
  check('非 kebab 的 name 被拒', r.status === 400 && /kebab/.test(r.body?.message ?? ''), JSON.stringify(r));
  r = await post({ name: 'nodesc', kind: 'dir', files: [{ path: 'SKILL.md', data: b64('---\nname: nodesc\n---\n\nbody') }] });
  check('缺 description 被拒', r.status === 400 && /description/.test(r.body?.message ?? ''), JSON.stringify(r));
  r = await post({ name: 'nofm', kind: 'dir', files: [{ path: 'SKILL.md', data: b64('# 没有 frontmatter') }] });
  check('缺 frontmatter 被拒', r.status === 400 && /frontmatter/.test(r.body?.message ?? ''), JSON.stringify(r));

  /* 8. 平铺 .md */
  r = await post({ name: 'flat-one', kind: 'flat', files: [{ path: 'flat-one.md', data: b64(withName('flat-one')) }] });
  check('平铺导入成功', r.status === 200 && fs.existsSync(path.join(skillsDir, 'flat-one.md')), JSON.stringify(r));
  check('平铺没有建同名目录', !fs.existsSync(path.join(skillsDir, 'flat-one')));

  /* 9. 请求体上限：/import 放宽到 24 MB，普通路由仍是 1 MB */
  const big = 'A'.repeat(1_500_000);
  r = await post({ name: 'big', kind: 'dir', files: [{ path: 'SKILL.md', data: b64(withName('big')) }, { path: 'big.bin', data: b64(big) }] });
  check('1.5 MB 文件可通过 import', r.status === 200, JSON.stringify(r));

  /* 10. 回环守卫 */
  r = await post({ name: 'x', kind: 'dir', files: [] }, '10.0.0.2');
  check('非回环 403', r.status === 403, JSON.stringify(r));

  /* 11. 没有破坏既有工具 */
  check('4 个对话工具仍在', tools.length === 4, tools.map((x) => x.name).join(','));
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

const failed = results.filter((x) => !x.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
