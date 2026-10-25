/**
 * @local/skill-manager —— 宿主半边
 *
 * 定位：不是「开关内置技能」的面板（内置技能在 app.asar 里只读，且技能服务没有 disable API），
 * 而是「技能工作台」：
 *   1. 看清现有技能：来源、是否对模型可见、描述占多少 prompt 预算（只读展示）
 *   2. 管理**你自己的**技能：创建 / 编辑 / 删除 / 真启停
 *
 * 真启停怎么来的：本插件向 `ctx.skills` 注册自己的 provider，扫 `<DSH_HOME>/skills`
 * 和 `<workspace>/.dsh/skills`（各一层：`<name>/SKILL.md` 或 `<name>.md`）。
 * 启停写在技能自己的 frontmatter 里（`disable-model-invocation` / `user-invocable`），
 * 这两个键是官方 provider 也认的语义，所以不是 UI 假象。
 *
 * 两个入口共用同一套 core：
 *   - 对话工具：skill_manager_list / save / toggle / delete
 *   - 图形界面：左侧栏入口 + 同源 HTTP 路由（<routePrefix>/list|read|save|import|toggle|delete）
 *     其中 import 供面板的「拖文件夹进来」用，会写整棵目录（scripts/、references/ 等）。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

export const name = 'skill-manager';

export const inject = ['tools', 'skills'];

/**
 * 不导出 schemastery 的 Config：本插件是 link 进 profile 的，按真实路径解析时
 * `@deepseek-ai/schemastery` 只能从 profile 的 node_modules 里找到，会激活失败。
 * 这里改为运行时归一化，缺字段一律给默认值。
 */
function normalizeConfig(input) {
  const raw = input && typeof input === 'object' ? input : {};
  return {
    routePrefix: typeof raw.routePrefix === 'string' && raw.routePrefix.trim()
      ? raw.routePrefix.trim()
      : '/api/skill-manager',
    skillRoot: typeof raw.skillRoot === 'string' ? raw.skillRoot.trim() : '',
    projectRoot: raw.projectRoot !== false,
  };
}

const PROVIDER_NAME = 'skill-manager';
const KEBAB_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_BODY = 512 * 1024;

/* 拖拽导入的上限：都在服务端卡一遍，客户端的预检只是为了早点报错 */
const MAX_IMPORT_BYTES = 24 * 1024 * 1024;
const MAX_IMPORT_FILES = 400;
const MAX_IMPORT_FILE_BYTES = 4 * 1024 * 1024;

function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

function skillRootOf(config) {
  return config.skillRoot ? path.resolve(config.skillRoot) : path.join(dshHome(), 'skills');
}

/* ───────────────────────── 导入（拖拽用） ───────────────────────── */

/**
 * 把浏览器给的名字规范成 kebab-case。
 * 拿不到合法名字时返回空串——CJK 目录名会落在这里，由调用方明确报错，
 * 而不是悄悄塞一个 `skill-1` 之类的名字进去。
 */
function kebabize(raw) {
  return String(raw ?? '')
    .normalize('NFKC')
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;

/**
 * 校验一个「相对技能目录」的路径。
 * 浏览器给的 path 是外部输入，一律按不可信处理：绝对路径、`..`、盘符、
 * Windows 非法字符与保留名全部拒绝，最后只交出用 `/` 连接的安全片段。
 */
function safeRelPath(raw) {
  const text = String(raw ?? '').replace(/\\/g, '/').trim();
  if (!text) throw new Error('文件路径为空');
  if (text.startsWith('/') || /^[A-Za-z]:/.test(text)) throw new Error(`拒绝绝对路径：${raw}`);
  const parts = text.split('/');
  for (const part of parts) {
    if (!part || part === '.' || part === '..') throw new Error(`路径含非法片段：${raw}`);
    if (/[<>:"|?*\u0000-\u001f]/.test(part)) throw new Error(`路径含非法字符：${raw}`);
    if (/[. ]$/.test(part)) throw new Error(`路径片段不能以点或空格结尾：${raw}`);
    if (WIN_RESERVED.test(part)) throw new Error(`路径命中 Windows 保留名：${raw}`);
  }
  return parts.join('/');
}

/* ───────────────────────── frontmatter ───────────────────────── */

function unquote(raw) {
  const v = String(raw).trim();
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    try {
      return JSON.parse(v);
    } catch {
      return v.slice(1, -1);
    }
  }
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1);
  return v;
}

/** 严格布尔：官方 provider 遇到非法拼写会丢弃整个技能，这里给出可诊断的结果。 */
function boolStrict(raw) {
  if (typeof raw === 'boolean') return raw;
  const v = String(raw ?? '').trim().toLowerCase();
  if (['true', 'yes', 'on', '1'].includes(v)) return true;
  if (['false', 'no', 'off', '0'].includes(v)) return false;
  return undefined;
}

function oneLine(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

function parseFrontmatter(text) {
  const src = String(text).replace(/^\uFEFF/, '');
  if (!src.startsWith('---')) {
    return { data: {}, body: src, error: '缺少 YAML frontmatter（文件必须以 --- 开头）' };
  }
  const lines = src.split(/\r?\n/);
  let end = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].trim() === '---') {
      end = i;
      break;
    }
  }
  if (end < 0) return { data: {}, body: src, error: 'frontmatter 缺少闭合的 --- ' };
  const data = {};
  let pendingKey = null;
  let pending = [];
  const flush = () => {
    if (!pendingKey) return;
    data[pendingKey] = pending.join(' ').trim();
    pendingKey = null;
    pending = [];
  };
  for (let i = 1; i < end; i += 1) {
    const line = lines[i];
    if (!line.trim()) continue;
    const m = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(line);
    if (m) {
      flush();
      const key = m[1];
      const value = m[2].trim();
      // 块标量：| > |- >- 等，后续缩进行拼成一行
      if (/^[|>][+-]?$/.test(value)) {
        pendingKey = key;
        pending = [];
        continue;
      }
      data[key] = unquote(value);
    } else if (pendingKey && /^\s+/.test(line)) {
      pending.push(line.trim());
    }
  }
  flush();
  const body = lines.slice(end + 1).join('\n').replace(/^\n+/, '');
  return { data, body, error: null };
}

function quote(value) {
  return JSON.stringify(oneLine(value));
}

function serializeSkill({ name: skillName, description, whenToUse, modelInvocable, userInvocable, body }) {
  const lines = ['---', `name: ${quote(skillName)}`, `description: ${quote(description)}`];
  if (oneLine(whenToUse)) lines.push(`whenToUse: ${quote(whenToUse)}`);
  if (modelInvocable === false) lines.push('disable-model-invocation: true');
  if (userInvocable === false) lines.push('user-invocable: false');
  const clean = String(body ?? '').replace(/\s+$/, '');
  lines.push('---', '', clean);
  return `${lines.join('\n')}\n`;
}

/** 只改 frontmatter 里一个键，正文和未知键原样保留。 */
function upsertFrontmatterKey(text, key, rawValue) {
  const src = String(text).replace(/^\uFEFF/, '');
  const lines = src.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') throw new Error('这个技能文件没有 frontmatter，无法切换');
  let end = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].trim() === '---') {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error('frontmatter 缺少闭合的 --- ');
  const head = lines.slice(0, end);
  const tail = lines.slice(end);
  const keyRe = new RegExp(`^${key}\\s*:`);
  const idx = head.findIndex((line) => keyRe.test(line));
  if (rawValue === null) {
    if (idx >= 0) head.splice(idx, 1);
  } else if (idx >= 0) {
    head[idx] = `${key}: ${rawValue}`;
  } else {
    const descIdx = head.findIndex((line) => /^description\s*:/.test(line));
    head.splice(descIdx >= 0 ? descIdx + 1 : head.length, 0, `${key}: ${rawValue}`);
  }
  return [...head, ...tail].join('\n');
}

/* ───────────────────────── 扫描 ───────────────────────── */

function rootsFor(config, cwd) {
  const roots = [];
  if (config.projectRoot) roots.push({ dir: path.join(cwd, '.dsh', 'skills'), source: 'project-dsh', rank: 100 });
  roots.push({ dir: skillRootOf(config), source: 'user-dsh', rank: 400 });
  return roots;
}

function readSkillFile(file, meta) {
  const problems = [];
  let text = '';
  try {
    const stat = fs.statSync(file);
    if (stat.size > MAX_BODY) problems.push(`文件过大（${stat.size} 字节）`);
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    return {
      name: path.basename(path.dirname(file)) === meta.dir ? '' : path.basename(file, '.md'),
      path: file,
      problems: [`读取失败：${error.message}`],
      source: meta.source,
      rank: meta.rank,
    };
  }
  const { data, body, error } = parseFrontmatter(text);
  if (error) problems.push(error);
  const skillName = typeof data.name === 'string' ? data.name.trim() : '';
  if (!skillName) problems.push('缺少 name');
  else if (!KEBAB_RE.test(skillName)) problems.push(`name 必须是 kebab-case：${skillName}`);
  const description = typeof data.description === 'string' ? data.description.trim() : '';
  if (!description) problems.push('缺少 description');
  /* 注意：disable-model-invocation 的值是「关闭开关」，不是「可见标志」本身。 */
  const disableRaw = data['disable-model-invocation'];
  const userRaw = data['user-invocable'];
  const disable = disableRaw === undefined ? false : boolStrict(disableRaw);
  const userInv = userRaw === undefined ? true : boolStrict(userRaw);
  if (disable === undefined) problems.push('disable-model-invocation 不是合法布尔值（true/false/yes/no/on/off/1/0）');
  if (userInv === undefined) problems.push('user-invocable 不是合法布尔值');
  return {
    name: skillName || path.basename(file, '.md'),
    description,
    whenToUse: typeof data.whenToUse === 'string' ? data.whenToUse.trim() : '',
    modelInvocable: disable !== true,
    userInvocable: userInv !== false,
    path: file,
    dir: meta.dir ?? null,
    flat: !meta.dir,
    linked: Boolean(meta.linkedPath),
    linkPath: meta.linkedPath ?? null,
    resourceBase: meta.dir ?? path.dirname(file),
    source: meta.source,
    rank: meta.rank,
    body,
    problems,
  };
}

function scanSkills(config, cwd) {
  const skills = [];
  const problems = [];
  for (const root of rootsFor(config, cwd)) {
    let entries;
    try {
      entries = fs.readdirSync(root.dir, { withFileTypes: true });
    } catch (error) {
      if (error.code !== 'ENOENT') problems.push({ path: root.dir, problems: [`扫描失败：${error.message}`] });
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const entryPath = path.join(root.dir, entry.name);
      let isDir = entry.isDirectory();
      let isFile = entry.isFile();
      let linkedPath = null;
      if (entry.isSymbolicLink()) {
        /* junction / 符号链接：Dirent 只报 isSymbolicLink，真实类型得 stat 一次。 */
        try {
          const stat = fs.statSync(entryPath);
          isDir = stat.isDirectory();
          isFile = stat.isFile();
          linkedPath = entryPath;
        } catch {
          continue;
        }
      }
      let file = null;
      let dir = null;
      if (isDir) {
        const candidate = path.join(entryPath, 'SKILL.md');
        if (fs.existsSync(candidate)) {
          file = candidate;
          dir = entryPath;
        }
      } else if (isFile && entry.name.toLowerCase().endsWith('.md')) {
        file = entryPath;
      }
      if (!file) continue;
      const skill = readSkillFile(file, { source: root.source, rank: root.rank, dir, linkedPath });
      if (skill.problems?.length) problems.push({ path: file, problems: skill.problems });
      skills.push(skill);
    }
  }
  return { skills, problems };
}

function insideRoots(config, cwd, target) {
  const resolved = path.resolve(target);
  return rootsFor(config, cwd).some((root) => {
    const rel = path.relative(path.resolve(root.dir), resolved);
    return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
  });
}

/* ───────────────────────── core ───────────────────────── */

function createCore(ctx, config, state) {
  const cwdOf = () => {
    try {
      const wd = ctx.get?.('workingDirectory');
      const dir = wd?.defaultDirectory;
      if (typeof dir === 'string' && dir) return dir;
    } catch {
      /* 没有就退化 */
    }
    return process.cwd();
  };

  const refresh = () => {
    try {
      state.control?.invalidate();
    } catch {
      /* provider 未就绪 */
    }
  };

  const findMine = (skills, skillName) => skills.find((s) => s.name === skillName);

  return {
    cwdOf,
    refresh,

    /** 建立清单：catalog（含内置）+ 我的文件细节 + 预算 */
    async list(cwdArg) {
      const cwd = cwdArg || cwdOf();
      const mine = scanSkills(config, cwd);
      const editable = new Map(mine.skills.map((s) => [path.resolve(s.path), s]));

      let catalog = [];
      let complete = true;
      try {
        const snapshot = await ctx.skills.snapshot({ cwd });
        catalog = snapshot.skills ?? [];
        complete = snapshot.complete !== false;
      } catch (error) {
        // 没拿到注册表也要能看自己的文件
        catalog = mine.skills.filter((s) => !s.problems.length).map((s) => ({
          name: s.name,
          description: s.description,
          whenToUse: s.whenToUse,
          source: s.source,
          invocation: { modelInvocable: s.modelInvocable, userInvocable: s.userInvocable },
          path: s.path,
        }));
        complete = false;
      }

      const rows = catalog.map((entry) => {
        const absolute = entry.path ? path.resolve(entry.path) : '';
        const local = editable.get(absolute);
        return {
          name: entry.name,
          description: entry.description,
          whenToUse: entry.whenToUse ?? '',
          source: entry.source ?? 'unknown',
          provider: entry.provider ?? '',
          modelInvocable: entry.invocation?.modelInvocable !== false,
          userInvocable: entry.invocation?.userInvocable !== false,
          editable: Boolean(local),
          path: entry.path ?? null,
          flat: Boolean(local?.flat),
        };
      });

      return {
        ok: true,
        message: rows.length ? `共 ${rows.length} 个技能` : '还没有任何技能',
        complete,
        root: skillRootOf(config),
        projectRoot: config.projectRoot ? path.join(cwd, '.dsh', 'skills') : null,
        builtin: rows.filter((r) => !r.editable).length,
        own: rows.filter((r) => r.editable).length,
        skills: rows.sort((a, b) => (a.editable === b.editable ? a.name.localeCompare(b.name) : a.editable ? -1 : 1)),
        problems: mine.problems,
      };
    },

    /** 只读查看：自己的技能直接读文件，内置技能向技能服务要正文。 */
    async readView(skillName, cwdArg) {
      const cwd = cwdArg || cwdOf();
      const { skills } = scanSkills(config, cwd);
      const found = findMine(skills, skillName);
      if (found) {
        return {
          ok: true,
          message: `已读取 ${skillName}`,
          kind: 'file',
          name: found.name,
          path: found.path,
          dir: found.dir ?? path.dirname(found.path),
          revealable: true,
          raw: fs.readFileSync(found.path, 'utf8'),
        };
      }

      /* 内置技能：清单里 path 是空的，正文只能由 provider 提供 */
      let def;
      try {
        def = await ctx.skills.get(skillName, { cwd });
      } catch (error) {
        def = undefined;
      }
      if (!def) throw new Error(`找不到技能：${skillName}`);
      const head = ['---', `name: ${def.name}`];
      if (def.description) head.push(`description: ${oneLine(def.description)}`);
      if (def.whenToUse) head.push(`whenToUse: ${oneLine(def.whenToUse)}`);
      if (def.invocation?.modelInvocable === false) head.push('disable-model-invocation: true');
      if (def.invocation?.userInvocable === false) head.push('user-invocable: false');
      head.push('---', '');
      return {
        ok: true,
        message: `已读取 ${skillName}（内置）`,
        kind: 'bundled',
        name: def.name ?? skillName,
        path: null,
        dir: null,
        revealable: false,
        raw: `${head.join('\n')}\n${def.content ?? ''}`,
      };
    },

    /** 用系统文件管理器打开技能目录。 */
    reveal(skillName, cwdArg) {
      const cwd = cwdArg || cwdOf();
      const { skills } = scanSkills(config, cwd);
      const found = findMine(skills, skillName);
      if (!found) throw new Error('内置技能打在 app.asar 里，没有可打开的目录');
      if (!insideRoots(config, cwd, found.path)) throw new Error('拒绝打开技能根目录之外的路径');
      const dir = found.dir ?? path.dirname(found.path);
      if (!fs.existsSync(dir)) throw new Error(`目录不存在：${dir}`);
      openInFileManager(dir);
      return { ok: true, message: `已在文件管理器中打开 ${found.name}`, path: dir };
    },

    /** 打开技能根目录（面板顶部那个按钮）。 */
    revealRoot() {
      const dir = skillRootOf(config);
      fs.mkdirSync(dir, { recursive: true });
      openInFileManager(dir);
      return { ok: true, message: '已在文件管理器中打开技能根目录', path: dir };
    },

    async save(input) {
      const cwd = input.cwd || cwdOf();
      const skillName = String(input.name ?? '').trim();
      if (!KEBAB_RE.test(skillName)) throw new Error('name 必须是 kebab-case（小写字母、数字、连字符）');
      const description = oneLine(input.description);
      if (!description) throw new Error('description 不能为空');
      const whenToUse = oneLine(input.whenToUse);
      const modelInvocable = input.modelInvocable !== false;
      const userInvocable = input.userInvocable !== false;
      const body = String(input.body ?? '');
      if (body.length > MAX_BODY) throw new Error('正文过大（上限 512 KB）');

      const { skills } = scanSkills(config, cwd);
      const existing = findMine(skills, skillName);

      if (existing && !input.overwrite) {
        // 允许编辑同一路径（客户端会带 overwrite），否则视为冲突
        throw new Error(`技能 ${skillName} 已存在；要修改请从列表里打开它`);
      }
      if (!existing) {
        // 不能和任何已有技能（含内置）撞名
        let taken = [];
        try {
          taken = (await ctx.skills.list({ cwd })).map((s) => s.name);
        } catch {
          taken = skills.map((s) => s.name);
        }
        if (taken.includes(skillName)) throw new Error(`技能名 ${skillName} 已被占用（含内置技能），换一个`);
      }

      const targetDir = existing?.dir ?? path.join(skillRootOf(config), skillName);
      const targetFile = existing?.flat ? existing.path : path.join(targetDir, 'SKILL.md');
      fs.mkdirSync(path.dirname(targetFile), { recursive: true });
      const content = serializeSkill({ name: skillName, description, whenToUse, modelInvocable, userInvocable, body });
      const tmp = `${targetFile}.tmp`;
      fs.writeFileSync(tmp, content, 'utf8');
      fs.renameSync(tmp, targetFile);
      refresh();
      return {
        ok: true,
        message: existing ? `已保存 ${skillName}` : `已创建 ${skillName}`,
        path: targetFile,
      };
    },

    /**
     * 拖拽导入：把浏览器读到的整棵目录写进 `<skillRoot>/<name>/`。
     *
     * 名字以 SKILL.md 的 frontmatter 为准（provider 认的是 frontmatter.name，
     * 不是目录名），所以不猜、不重命名，frontmatter 不合法就直接拒绝。
     *
     * 先写进同盘的临时目录、校验通过后整体 rename，中途失败不会留下半个技能。
     */
    async importSkill(input) {
      const cwd = input.cwd || cwdOf();
      const files = Array.isArray(input.files) ? input.files : [];
      if (!files.length) throw new Error('没有收到任何文件');
      if (files.length > MAX_IMPORT_FILES) throw new Error(`文件太多（上限 ${MAX_IMPORT_FILES} 个）`);

      /* 解码 + 尺寸检查：全部做完再落盘 */
      const decoded = files.map((file) => {
        const rel = safeRelPath(file.path);
        const buf = Buffer.from(String(file.data ?? ''), 'base64');
        if (!buf.length) throw new Error(`文件是空的：${rel}`);
        if (buf.length > MAX_IMPORT_FILE_BYTES) {
          throw new Error(`单个文件超过 ${Math.round(MAX_IMPORT_FILE_BYTES / 1024 / 1024)} MB：${rel}`);
        }
        return { rel, buf };
      });

      const flat = input.kind === 'flat';
      const skillFile = decoded.find((f) => f.rel.toLowerCase() === 'skill.md');
      if (flat) {
        if (decoded.length !== 1 || decoded[0].rel.includes('/')) throw new Error('平铺技能只接受单个 .md 文件');
        if (!/\.md$/i.test(decoded[0].rel)) throw new Error('平铺技能的文件必须以 .md 结尾');
      } else if (!skillFile) {
        throw new Error('拖进来的目录里没有根级 SKILL.md，不是技能目录');
      }
      const skillText = (flat ? decoded[0].buf : skillFile.buf).toString('utf8');

      const { data, error } = parseFrontmatter(skillText);
      if (error) throw new Error(`frontmatter 有问题：${error}`);
      const skillName = typeof data.name === 'string' ? data.name.trim() : '';
      if (!skillName) throw new Error('frontmatter 缺少 name');
      if (!KEBAB_RE.test(skillName)) throw new Error(`frontmatter 的 name 必须是 kebab-case：${skillName}`);
      if (!oneLine(data.description)) throw new Error('frontmatter 缺少 description');

      const { skills } = scanSkills(config, cwd);
      if (findMine(skills, skillName)) throw new Error(`技能 ${skillName} 已存在；要替换请先删掉它`);
      let taken = [];
      try {
        taken = (await ctx.skills.list({ cwd })).map((s) => s.name);
      } catch {
        taken = skills.map((s) => s.name);
      }
      if (taken.includes(skillName)) throw new Error(`技能名 ${skillName} 已被占用（含内置技能），换一个`);

      const root = skillRootOf(config);
      fs.mkdirSync(root, { recursive: true });
      const staging = path.join(root, `.import-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
      fs.mkdirSync(staging, { recursive: true });
      let done = false;
      try {
        let total = 0;
        for (const file of decoded) {
          total += file.buf.length;
          if (total > MAX_IMPORT_BYTES) throw new Error('导入内容过大');
          const target = path.join(staging, file.rel);
          const relCheck = path.relative(staging, target);
          if (!relCheck || relCheck.startsWith('..') || path.isAbsolute(relCheck)) {
            throw new Error(`拒绝写到技能目录之外：${file.rel}`);
          }
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, file.buf);
        }

        if (flat) {
          const finalFile = path.join(root, `${skillName}.md`);
          fs.renameSync(path.join(staging, decoded[0].rel), finalFile);
          fs.rmSync(staging, { recursive: true, force: true });
          done = true;
          refresh();
          return { ok: true, message: `已导入 ${skillName}（平铺技能）`, path: finalFile, files: 1 };
        }

        const finalDir = path.join(root, skillName);
        fs.renameSync(staging, finalDir);
        done = true;
        refresh();
        return {
          ok: true,
          message: `已导入 ${skillName}（${decoded.length} 个文件）`,
          path: path.join(finalDir, 'SKILL.md'),
          files: decoded.length,
        };
      } finally {
        if (!done) {
          try {
            fs.rmSync(staging, { recursive: true, force: true });
          } catch {
            /* 清理失败不掩盖原始错误 */
          }
        }
      }
    },

    toggle(skillName, surface, value, cwdArg) {
      const cwd = cwdArg || cwdOf();
      const { skills } = scanSkills(config, cwd);
      const found = findMine(skills, skillName);
      if (!found) throw new Error(`找不到你自己的技能：${skillName}`);
      if (surface !== 'model' && surface !== 'user') throw new Error('surface 只能是 model 或 user');
      const enabled = Boolean(value);
      const key = surface === 'model' ? 'disable-model-invocation' : 'user-invocable';
      // 默认是开启，所以「开启」= 删掉键，「关闭」= 写 true/false
      const raw = enabled ? null : surface === 'model' ? 'true' : 'false';
      const text = fs.readFileSync(found.path, 'utf8');
      const next = upsertFrontmatterKey(text, key, raw);
      const tmp = `${found.path}.tmp`;
      fs.writeFileSync(tmp, next, 'utf8');
      fs.renameSync(tmp, found.path);
      refresh();
      return {
        ok: true,
        message: `${skillName} 的${surface === 'model' ? '模型可见' : '用户可调用'}已${enabled ? '开启' : '关闭'}`,
        path: found.path,
      };
    },

    remove(skillName, cwdArg) {
      const cwd = cwdArg || cwdOf();
      const { skills } = scanSkills(config, cwd);
      const found = findMine(skills, skillName);
      if (!found) throw new Error(`找不到你自己的技能：${skillName}`);
      if (!insideRoots(config, cwd, found.path)) throw new Error('拒绝删除技能根目录之外的文件');
      if (found.linked) {
        /* junction / 符号链接：只摘掉链接本身，绝不递归删真实目录。 */
        fs.rmdirSync(found.dir ?? found.linkPath);
      } else if (found.dir) {
        fs.rmSync(found.dir, { recursive: true, force: true });
      } else {
        fs.rmSync(found.path, { force: true });
      }
      refresh();
      return { ok: true, message: `已删除 ${skillName}`, path: found.path };
    },
  };
}

/* ───────────────────────── HTTP 路由 ───────────────────────── */

/** 交给系统文件管理器打开一个目录（失败不抛给调用方，只记在返回值里）。 */
function openInFileManager(dir) {
  const [command, args] = process.platform === 'win32'
    ? ['explorer.exe', [dir]]
    : process.platform === 'darwin'
      ? ['open', [dir]]
      : ['xdg-open', [dir]];
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    /* 没有 error 监听时，spawn 失败会抛未捕获异常，直接带走主进程 */
    child.on('error', () => {});
    child.unref();
  } catch {
    throw new Error('无法启动系统文件管理器');
  }
}

const RESULT_SCHEMA = {
  type: 'object',
  properties: { ok: { type: 'boolean' }, message: { type: 'string' } },
  required: ['ok', 'message'],
  additionalProperties: true,
};

function readBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      size += buf.length;
      if (size > limit) {
        reject(new Error(`请求体过大（上限 ${Math.round(limit / 1024 / 1024)} MB）`));
        req.destroy();
        return;
      }
      chunks.push(buf);
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
            try {
              sendJson(res, 200, await handler(req));
            } catch (error) {
              sendJson(res, 400, { ok: false, message: error.message });
            }
          },
        }));
      };

      route('list', ['GET', 'POST'], async () => core.list());
      route('read', ['POST'], async (req) => {
        const body = await readBody(req);
        return core.readView(body.name, body.cwd);
      });
      route('reveal', ['POST'], async (req) => {
        const body = await readBody(req);
        if (body.scope === 'root' || !body.name) return core.revealRoot();
        return core.reveal(body.name, body.cwd);
      });
      route('save', ['POST'], async (req) => core.save({ ...(await readBody(req)), overwrite: true }));
      /* 拖拽导入：整棵目录 base64 上来，所以单独放宽请求体上限 */
      route('import', ['POST'], async (req) => core.importSkill({ ...(await readBody(req, MAX_IMPORT_BYTES)), overwrite: false }));
      route('toggle', ['POST'], async (req) => {
        const body = await readBody(req);
        return core.toggle(body.name, body.surface, body.value, body.cwd);
      });
      route('delete', ['POST'], async (req) => {
        const body = await readBody(req);
        return core.remove(body.name, body.cwd);
      });

      logger.info(`skill-manager 路由已挂载：${prefix}/*`);
      return () => {
        for (const off of dispose) {
          try {
            off();
          } catch {
            /* 卸载阶段忽略 */
          }
        }
      };
    }, 'skill-manager: http routes');
  });
}

/* ───────────────────────── 工具输出 ───────────────────────── */

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
  const skills = value.skills ?? [];
  if (!skills.length) return ['（没有任何技能）'];
  return skills.map((s) => {
    const kind = s.editable ? '我的' : '内置';
    const model = s.modelInvocable ? '模型可见' : '模型不可见';
    const user = s.userInvocable ? '' : '/用户不可调用';
    return `- ${s.name} [${kind}/${s.source}] ${model}${user} · ${s.description}`;
  });
});

const actionOutput = textOutput(() => []);

/* ───────────────────────── 插件入口 ───────────────────────── */

export async function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig);
  const logger = typeof ctx.logger === 'function' ? ctx.logger('skill-manager') : (ctx.logger ?? console);
  const state = { control: null };
  const core = createCore(ctx, config, state);
  const disposers = [];

  /* 注册自己的 provider：这些技能真的会进注册表，不是只在面板里显示 */
  try {
    const off = ctx.skills.registerProvider((control) => {
      state.control = control;
      return {
        name: PROVIDER_NAME,
        async list(options) {
          const cwd = options?.cwd || core.cwdOf();
          const { skills } = scanSkills(config, cwd);
          return {
            complete: true,
            candidates: skills
              .filter((s) => !s.problems?.length)
              .map((s) => ({
                name: s.name,
                description: s.description,
                ...(s.whenToUse ? { whenToUse: s.whenToUse } : {}),
                invocation: { modelInvocable: s.modelInvocable, userInvocable: s.userInvocable },
                source: s.source,
                provider: PROVIDER_NAME,
                rank: s.rank,
                path: s.path,
                resourceBase: s.resourceBase,
                locator: { path: s.path },
              })),
          };
        },
        async get(candidate) {
          const file = candidate?.locator?.path ?? candidate?.path;
          if (!file) return undefined;
          const found = readSkillFile(file, { source: candidate.source ?? 'user-dsh', rank: candidate.rank ?? 400, dir: null });
          if (found.problems?.length) return undefined;
          return {
            name: found.name,
            description: found.description,
            ...(found.whenToUse ? { whenToUse: found.whenToUse } : {}),
            invocation: { modelInvocable: found.modelInvocable, userInvocable: found.userInvocable },
            source: found.source,
            provider: PROVIDER_NAME,
            path: found.path,
            resourceBase: found.resourceBase,
            content: found.body,
          };
        },
      };
    });
    disposers.push(off);
    logger.info(`skill-manager provider 已注册，技能根：${skillRootOf(config)}`);
  } catch (error) {
    logger.warn(`skill-manager provider 注册失败：${error.message}`);
  }

  const register = (def) => {
    disposers.push(ctx.tools.register(def));
  };

  register({
    name: 'skill_manager_list',
    description:
      '列出所有技能：内置的（只读，来自 app.asar）和你自己写的（在 <DSH_HOME>/skills 或工作区 .dsh/skills 下）。'
      + '给出名称、来源、是否对模型可见、是否可 /调用。',
    parameters: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: '工作区目录；省略则用当前会话的工作目录' },
      },
      additionalProperties: false,
    },
    output: listOutput,
    async execute(args) {
      return core.list(args?.cwd);
    },
  });

  register({
    name: 'skill_manager_save',
    description:
      '创建或覆盖一个你自己的技能（写 <DSH_HOME>/skills/<name>/SKILL.md）。'
      + 'description 会进入模型看到的技能目录，写清“什么时候该用”；正文才是真正加载的指令。'
      + 'name 必须 kebab-case，且不能和任何已有技能（含内置）重名。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'kebab-case 技能名，如 pdf-report' },
        description: { type: 'string', description: '一句话说明何时使用，会展示给模型' },
        whenToUse: { type: 'string', description: '可选的补充触发说明' },
        modelInvocable: { type: 'boolean', description: '是否让模型自动可用，默认 true' },
        userInvocable: { type: 'boolean', description: '是否允许用户用 /name 调用，默认 true' },
        body: { type: 'string', description: '技能正文（markdown），加载时才注入' },
      },
      required: ['name', 'description'],
      additionalProperties: false,
    },
    output: actionOutput,
    timeoutMs: 60_000,
    async execute(args) {
      return core.save({ ...(args ?? {}), overwrite: true });
    },
  });

  register({
    name: 'skill_manager_toggle',
    description: '开启或关闭你自己某个技能的一路入口：surface=model 控制模型能否自动使用，surface=user 控制能否用 /name 调用。改的是技能文件里的 frontmatter。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '技能名' },
        surface: { type: 'string', enum: ['model', 'user'], description: 'model = 给模型用，user = 给人用' },
        value: { type: 'boolean', description: 'true 开启 / false 关闭' },
      },
      required: ['name', 'surface', 'value'],
      additionalProperties: false,
    },
    output: actionOutput,
    timeoutMs: 60_000,
    async execute(args) {
      return core.toggle(args?.name, args?.surface, args?.value);
    },
  });

  register({
    name: 'skill_manager_delete',
    description: '删除你自己创建的一个技能（移除它在技能根下的目录或 .md 文件）。内置技能不可删除。',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: '技能名' } },
      required: ['name'],
      additionalProperties: false,
    },
    output: actionOutput,
    timeoutMs: 60_000,
    async execute(args) {
      return core.remove(args?.name);
    },
  });

  try {
    mountWebUi(ctx, config, core, logger);
  } catch (error) {
    logger.warn(`skill-manager 路由挂载失败：${error.message}`);
  }

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
