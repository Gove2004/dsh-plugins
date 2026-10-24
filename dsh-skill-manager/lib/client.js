/**
 * @local/skill-manager —— 客户端半边（手写无构建）
 *
 * 注册两处，靠 id/key 配对由框架完成导航：
 *   - `sidebar.panellist`（左侧栏入口，id = 'skill-manager'）
 *   - `main`（主区域整页，key = 'skill-manager'）
 *
 * 视觉对齐 DSH 原生面板（数值取自宿主实测）：
 *   正文 14px / 次要 13px / 分组小字 12px、按钮 13px 高 28 圆角 8、
 *   行 padding 10px 8px 10px 12px + border-bottom、弹窗 radius-panel、输入类 30px。
 *
 * 诚实边界（都体现在界面上，不装饰）：
 *   - 内置技能在 app.asar 内：开关显示为「已启用且不可点」，没有删除，也没有可打开的目录。
 *   - 面板不编辑正文。查看是只读的，改写交给文件管理器 + 你自己的编辑器。
 */

window.__ModuleLoader__.load({
  id: '@local/skill-manager',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const PANEL_ID = 'skill-manager';
    const NS = 'skillManager';
    const API = '/api/skill-manager';

    const ZH = {
      panel: 'Skill Manager',
      title: 'Skill Manager',
      refresh: '刷新',
      empty: '还没有任何技能',
      loading: '加载中…',
      busy: '处理中…',
      cancel: '取消',
      close: '关闭',
      del: '删除',
      mine: '我的技能',
      builtin: '内置技能',
      hintMerged: '我的技能可启停 / 查看 / 删除 · 内置技能随构建提供，只读（在 app.asar 内）',
      folder: '浏览',
      folderTitle: '打开技能根目录',
      delQ: '删除技能 {name}？它的目录会被整个移除。',
      delBuiltin: '内置技能在 app.asar 内，不可删除',
      builtinNote: '内置技能的正文由技能服务提供，上面这层 frontmatter 是按清单重建的。',
      viewHint: '查看 SKILL.md',
      enabled: '模型可见（点掉即关闭）',
      enabledBuiltin: '内置技能固定启用',
      httpFail: '服务端返回了非 JSON 内容（HTTP {status}）',    };

    const EN = {
      panel: 'Skill Manager',
      title: 'Skill Manager',
      refresh: 'Refresh',
      empty: 'No skills yet',
      loading: 'Loading…',
      busy: 'Working…',
      cancel: 'Cancel',
      close: 'Close',
      del: 'Delete',
      mine: 'Mine',
      builtin: 'Built-in',
      hintMerged: 'Mine can be toggled / viewed / deleted · built-ins ship with the build and stay read-only (inside app.asar)',
      folder: 'Browse',
      folderTitle: 'Open skill root folder',
      delQ: 'Delete skill {name}? Its directory is removed entirely.',
      delBuiltin: 'Built-in skills live in app.asar and cannot be deleted',
      builtinNote: 'The body comes from the skill service; the frontmatter above is rebuilt from the catalog.',
      viewHint: 'View SKILL.md',
      enabled: 'Model-visible (uncheck to disable)',
      enabledBuiltin: 'Built-in skills are always enabled',
      httpFail: 'Server returned non-JSON (HTTP {status})',
    };

    function fill(template, vars) {
      return String(template).replace(/\{(\w+)\}/g, (_m, key) => (vars[key] === undefined ? '' : String(vars[key])));
    }

    async function callApi(suffix, payload) {
      const init = payload === undefined
        ? { method: 'GET' }
        : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) };
      const response = await fetch(`${API}/${suffix}`, init);
      const text = await response.text();
      let data;
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        throw new Error(`HTTP ${response.status}`);
      }
      if (!response.ok || data.ok === false) throw new Error(data.message || `HTTP ${response.status}`);
      return data;
    }

    /* ── 小图标 ── */

    function BookIcon(props) {
      const size = Number(props?.size) || 20;
      return h('svg', {
        viewBox: '0 0 24 24',
        width: size,
        height: size,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.7,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
      },
      /* 合上的书：圆角封面 + 左侧书脊折痕 + 从书口垂下的书签 */
      h('rect', { x: 4, y: 2.75, width: 16, height: 18.5, rx: 2.2 }),
      h('path', { d: 'M8.4 2.75v18.5' }),
      h('path', { d: 'M15.3 2.75v6.3l-1.75-1.4-1.75 1.4V2.75' }));
    }

    function FolderIcon() {
      return h('svg', {
        viewBox: '0 0 24 24', width: 16, height: 16, fill: 'none', stroke: 'currentColor',
        strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true',
      },
      h('path', { d: 'M3.6 7.2a1.6 1.6 0 0 1 1.6-1.6h3.5l1.7 2.1h7.9a1.6 1.6 0 0 1 1.6 1.6v7.5a1.6 1.6 0 0 1-1.6 1.6H5.2a1.6 1.6 0 0 1-1.6-1.6z' }));
    }

    /* ── 主页面 ── */

    function SkillPage(props) {
      const t = props.t;
      const [data, setData] = React.useState(null);
      const [loading, setLoading] = React.useState(true);
      const [busy, setBusy] = React.useState('');
      const [msg, setMsg] = React.useState('');
      const [err, setErr] = React.useState('');
      const [viewer, setViewer] = React.useState(null);
      const [confirming, setConfirming] = React.useState(null);

      const load = React.useCallback(async () => {
        setLoading(true);
        try {
          setData(await callApi('list'));
          setErr('');
        } catch (error) {
          setErr(error.message);
        } finally {
          setLoading(false);
        }
      }, []);

      React.useEffect(() => {
        load();
      }, [load]);

      const cancelViewer = React.useCallback(() => {
        setViewer((current) => (current?.loading ? current : null));
      }, []);

      React.useEffect(() => {
        if (!viewer) return undefined;
        const onKey = (event) => {
          if (event.key === 'Escape') cancelViewer();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
      }, [viewer, cancelViewer]);

      const skills = data?.skills ?? [];
      const mine = skills.filter((s) => s.editable);
      const builtins = skills.filter((s) => !s.editable);

      async function openView(item) {
        setMsg('');
        setErr('');
        setViewer({
          name: item.name,
          loading: true,
          raw: '',
          path: item.path,
          dir: item.path ? item.path.replace(/[\\/][^\\/]+$/, '') : null,
          readable: item.editable,
        });
        try {
          const detail = await callApi('read', { name: item.name });
          setViewer({
            name: detail.name,
            loading: false,
            raw: detail.raw,
            path: detail.path,
            dir: detail.dir,
            kind: detail.kind,
            readable: detail.revealable,
          });
        } catch (error) {
          setViewer(null);
          setErr(error.message);
        }
      }

      async function openRoot() {
        setMsg('');
        setErr('');
        try {
          const result = await callApi('reveal', { scope: 'root' });
          setMsg(result.message);
        } catch (error) {
          setErr(error.message);
        }
      }

      async function toggle(item, value) {
        setBusy(item.name);
        setMsg('');
        setErr('');
        try {
          const result = await callApi('toggle', { name: item.name, surface: 'model', value });
          setMsg(result.message);
          await load();
        } catch (error) {
          setErr(error.message);
        } finally {
          setBusy('');
        }
      }

      async function remove() {
        if (!confirming) return;
        const name = confirming.name;
        setConfirming(null);
        setBusy(name);
        try {
          const result = await callApi('delete', { name });
          setMsg(result.message);
          await load();
        } catch (error) {
          setErr(error.message);
        } finally {
          setBusy('');
        }
      }

      function row(item) {
        const editable = item.editable;
        const working = busy === item.name;
        const locked = !editable;
        return h('div', { className: 'skm-row', key: `${item.source}:${item.name}` },
          h('input', {
            type: 'checkbox',
            className: 'skm-ck',
            checked: item.modelInvocable,
            disabled: locked || working || Boolean(busy),
            title: locked ? t('enabledBuiltin') : t('enabled'),
            onChange: (event) => toggle(item, event.target.checked),
          }),
          h('button', {
            type: 'button',
            className: 'skm-main',
            title: item.path || t('viewHint'),
            onClick: () => openView(item),
          },
          h('span', { className: 'skm-n' }, item.name),
          h('span', { className: 'skm-d' }, item.description || '—')),
          editable
            ? h('button', {
              type: 'button',
              className: 'skm-btn skm-btn-del',
              title: t('del'),
              onClick: () => setConfirming(item),
            }, t('del'))
            : h('button', {
              type: 'button',
              className: 'skm-btn',
              disabled: true,
              title: t('delBuiltin'),
            }, t('del')));
      }

      function group(label, items) {
        if (!items.length) return null;
        return h('div', { className: 'skm-group' },
          h('div', { className: 'skm-gh' },
            h('span', { className: 'skm-gt' }, label),
            h('span', { className: 'skm-gc' }, String(items.length))),
          h('div', { className: 'skm-list' }, items.map(row)));
      }

      return h('div', { className: 'skm' },
        h('div', { className: 'skm-in' },
          h('div', { className: 'skm-head' },
            h('h1', { className: 'skm-h' }, t('title')),
            h('button', {
              type: 'button',
              className: 'skm-btn',
              title: t('folderTitle'),
              disabled: Boolean(busy),
              onClick: openRoot,
            }, h(FolderIcon), t('folder')),
            h('button', {
              type: 'button',
              className: 'skm-btn',
              disabled: loading || Boolean(busy),
              onClick: load,
            }, `↻ ${t('refresh')}`)),
          h('p', { className: 'skm-hint' }, t('hintMerged')),
          err ? h('p', { className: 'skm-msg skm-msg-err' }, err) : null,
          msg ? h('p', { className: 'skm-msg' }, msg) : null,
          loading && !data ? h('div', { className: 'skm-empty' }, t('loading')) : null,
          !loading && !skills.length ? h('div', { className: 'skm-empty' }, t('empty')) : null,
          group(t('mine'), mine),
          group(t('builtin'), builtins)),

        viewer ? h('div', { className: 'skm-root', role: 'presentation' },
          h('div', {
            className: 'skm-mask',
            onClick: () => (viewer.loading ? null : setViewer(null)),
            'aria-hidden': 'true',
          }),
          h('div', { className: 'skm-dlg', role: 'dialog', 'aria-modal': 'true', 'aria-label': viewer.name },
            h('div', { className: 'skm-dlg-h' },
              h('h2', { className: 'skm-dlg-t skm-dlg-path', title: viewer.path || viewer.name },
                viewer.path || viewer.name),
              h('button', {
                type: 'button',
                className: 'skm-icon',
                onClick: () => setViewer(null),
                'aria-label': t('close'),
              }, '×')),
            h('div', { className: 'skm-dlg-b' },
              viewer.loading
                ? h('div', { className: 'skm-empty' }, t('loading'))
                : h('pre', { className: 'skm-raw' }, viewer.raw),
              viewer.kind === 'bundled' ? h('p', { className: 'skm-note' }, t('builtinNote')) : null)))
          : null,

        confirming ? h('div', { className: 'skm-root', role: 'presentation' },
          h('div', {
            className: 'skm-mask',
            onClick: () => (busy ? null : setConfirming(null)),
            'aria-hidden': 'true',
          }),
          h('div', { className: 'skm-dlg skm-dlg-sm', role: 'dialog', 'aria-modal': 'true' },
            h('div', { className: 'skm-dlg-h' }, h('h2', { className: 'skm-dlg-t' }, t('del'))),
            h('div', { className: 'skm-dlg-b' },
              h('p', { className: 'skm-msg' }, fill(t('delQ'), { name: confirming.name }))),
            h('div', { className: 'skm-dlg-f' },
              h('button', { type: 'button', className: 'skm-btn', onClick: () => setConfirming(null) }, t('cancel')),
              h('button', {
                type: 'button',
                className: 'skm-btn skm-btn-warn',
                onClick: remove,
              }, t('del')))))
          : null);
    }

    const CSS = `
.skm { height:100%; overflow-y:auto; padding:24px 28px 40px; box-sizing:border-box;
  color:var(--dsw-alias-label-primary); font:inherit; font-size:14px; }
.skm-in { max-width:820px; margin:0 auto; }
.skm-head { display:flex; align-items:center; gap:2px; margin-bottom:4px; }
.skm-h { margin:0; flex:1; min-width:0; font-size:14px; font-weight:600; letter-spacing:.01em; }
.skm-hint { margin:0 0 16px; font-size:13px; color:var(--dsw-alias-label-secondary);
  overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.skm-msg { margin:0 0 10px; font-size:13px; color:var(--dsw-alias-label-secondary); }
.skm-msg-err { color:var(--dsw-alias-state-error-primary); }
.skm-empty { padding:18px 2px; font-size:13px; color:var(--dsw-alias-label-secondary); }
.skm-group + .skm-group { margin-top:20px; }
.skm-gh { display:flex; align-items:baseline; gap:10px; min-width:0; padding:0 2px 8px; }
.skm-gt { flex:none; font-size:13px; font-weight:600; }
.skm-gc { flex:none; font-size:12px; color:var(--dsw-alias-label-secondary);
  font-variant-numeric:tabular-nums; }
.skm-list { border-top:1px solid var(--dsw-alias-border-l2); }
.skm-row { display:grid; grid-template-columns:16px minmax(0,1fr) auto; align-items:center;
  gap:10px; padding:10px 8px 10px 12px; border-bottom:1px solid var(--dsw-alias-border-l2); }
.skm-row:hover { background:var(--dsw-alias-interactive-bg-hover); }
.skm-ck { width:16px; height:16px; margin:0; cursor:pointer;
  accent-color:var(--dsw-alias-brand-primary); }
.skm-ck:disabled { cursor:default; opacity:.55; }
.skm-main { min-width:0; display:flex; flex-direction:column; gap:2px; padding:0; border:0;
  background:transparent; font:inherit; color:inherit; text-align:left; cursor:pointer; }
.skm-main:focus-visible { outline:2px solid var(--dsw-alias-brand-primary); outline-offset:3px;
  border-radius:6px; }
.skm-n { min-width:0; font-size:14px; font-weight:600; overflow:hidden;
  text-overflow:ellipsis; white-space:nowrap; }
.skm-d { min-width:0; font-size:13px; color:var(--dsw-alias-label-secondary);
  overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.skm-btn { display:inline-flex; align-items:center; gap:5px; border:0; background:transparent;
  padding:6px 8px; font:inherit; font-size:13px; font-weight:400; line-height:1.25;
  color:var(--dsw-alias-label-secondary); border-radius:8px; cursor:pointer; white-space:nowrap;
  transition:color .15s ease,background .15s ease; }
.skm-btn:hover:not(:disabled) { background:var(--dsw-alias-interactive-bg-hover);
  color:var(--dsw-alias-label-primary); }
.skm-btn:disabled { opacity:.45; cursor:default; }
.skm-btn:focus-visible { outline:2px solid var(--dsw-alias-brand-primary); outline-offset:1px; }
.skm-btn-warn { color:var(--dsw-alias-state-error-primary); }
.skm-btn-del:hover:not(:disabled) { color:var(--dsw-alias-state-error-primary); }
.skm-btn:disabled { opacity:.35; cursor:default; }
.skm-root { position:fixed; inset:0; z-index:1200; display:grid; place-items:center; padding:24px; }
.skm-mask { position:absolute; inset:0;
  background:var(--dsw-alias-bg-mask-1,var(--dsw-alias-bg-overlay)); }
.skm-dlg { position:relative; display:flex; flex-direction:column; font-size:14px;
  width:760px; max-width:calc(100vw - 48px); max-height:min(86vh,860px); overflow:hidden;
  border-radius:var(--dsw-radius-panel,20px); background:var(--dsw-alias-bg-layer-2);
  color:var(--dsw-alias-label-primary); box-shadow:var(--dsw-elevation-prominent,none); }
.skm-dlg-sm { width:420px; }
.skm-dlg-h { display:flex; flex:none; align-items:center; gap:8px; padding:18px 20px 12px 24px; }
.skm-dlg-t { margin:0; flex:1 1 auto; min-width:0; font-size:15px; font-weight:600;
  overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.skm-dlg-path { font-family:var(--dsw-font-mono,ui-monospace,monospace); font-size:12.5px;
  font-weight:500; }
.skm-dlg-b { display:flex; flex-direction:column; gap:10px; flex:1 1 auto; min-height:0;
  overflow:hidden; padding:2px 24px 22px; }
.skm-dlg-f { display:flex; flex:none; align-items:center; justify-content:flex-end; gap:4px;
  padding:12px 24px 16px; border-top:1px solid var(--dsw-alias-border-l2); }
.skm-note { margin:0; font-size:12px; color:var(--dsw-alias-label-secondary); }
.skm-raw { margin:0; flex:1 1 auto; min-height:120px; overflow:auto; white-space:pre-wrap;
  overflow-wrap:anywhere; font-family:var(--dsw-font-mono,ui-monospace,monospace);
  font-size:12.5px; line-height:1.62; padding:12px 14px; border-radius:10px;
  background:var(--dsw-alias-bg-base); border:1px solid var(--dsw-alias-border-l2);
  color:var(--dsw-alias-label-primary); }
.skm-icon { width:28px; height:28px; flex:none; display:grid; place-items:center; border:0;
  background:transparent; border-radius:8px; color:var(--dsw-alias-label-secondary); cursor:pointer;
  font:inherit; font-size:15px; line-height:1; }
.skm-icon:hover:not(:disabled) { background:var(--dsw-alias-interactive-bg-hover);
  color:var(--dsw-alias-label-primary); }
`;

    /* ── 注册 ── */
    const inject = ['slots', 'locale'];

    function apply(ctx) {
      const locale = ctx.locale;

      ctx.effect(() => {
        let active = 'en';
        try {
          active = String(locale.getLocale().active || 'en');
        } catch {
          active = 'en';
        }
        const tags = active === 'zh' || active === 'en' ? ['zh', 'en'] : [active, 'zh', 'en'];
        const seen = {};
        const offs = [];
        for (const tag of tags) {
          if (seen[tag]) continue;
          seen[tag] = true;
          offs.push(locale.register(NS, tag, tag === 'zh' ? ZH : EN));
        }
        return () => {
          for (const off of offs) {
            try {
              off();
            } catch {
              /* 卸载阶段忽略 */
            }
          }
        };
      }, 'skill-manager: dictionaries');

      ctx.effect(() => {
        const el = document.createElement('style');
        el.setAttribute('data-skill-manager', '');
        el.textContent = CSS;
        document.head.appendChild(el);
        return () => {
          try {
            el.remove();
          } catch {
            /* 已移除 */
          }
        };
      }, 'skill-manager: styles');

      const t = locale.bind(NS);

      ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main',
        key: PANEL_ID,
        locale: NS,
        inject: () => ({ t }),
      }, SkillPage));

      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: 31,
        label: () => t('panel'),
      }, BookIcon));
    }

    return { inject, apply };
  },
});
