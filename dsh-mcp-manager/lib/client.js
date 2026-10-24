/**
 * @local/mcp-manager —— 客户端半边（手写无构建）
 *
 * 宿主用 `window.__ModuleLoader__.load({ id, factory })` 载入，**只 require `react`**。
 * 注册两处，靠 id/key 配对由框架完成导航：
 *   - `sidebar.panellist`（左侧栏入口，id = 'mcp-manager'）
 *   - `main`（主区域整页，key = 'mcp-manager'）
 *
 * 视觉对齐 DSH 自带面板（参照 archive-manager / free-search 的写法）：
 *   - 原生 checkbox + accent-color 做启停（不自己画胶囊开关）
 *   - 纯文本按钮：border:0、transparent、hover 用 --dsw-alias-interactive-bg-hover
 *   - 行：grid + border-bottom:border-l2 + padding 10px 12px，两行信息（名称/目标）
 *   - 弹窗：position:fixed + grid place-items:center + bg-mask-1 + radius-panel
 */

window.__ModuleLoader__.load({
  id: '@local/mcp-manager',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const PANEL_ID = 'mcp-manager';
    const NS = 'mcpManager';
    const API = '/api/mcp-manager';

    /* 词典里只放字符串（locale 字典类型是 Record<string,string>），{x} 用 fill 填。 */
    const ZH = {
      panel: 'MCP Manager',
      title: 'MCP Manager',
      add: '新增',
      refresh: '刷新',
      empty: '还没有 MCP 服务器',
      edit: '编辑',
      del: '删除',
      enable: '启用',
      disable: '停用',
      pending: '未连接',
      delQ: '删除 {name}？',
      cancel: '取消',
      save: '保存',
      close: '关闭',
      loading: '加载中…',
      busy: '处理中…',
      namePh: '名称',
      typeLbl: '类型',
      urlPh: '端点 URL',
      cmdPh: '命令',
      argsPh: '参数（JSON 数组）',
      envPh: '环境变量',
      headersPh: '请求头',
      cwdPh: '工作目录',
      notePh: '备注',
      typeHttp: '远端 streamable-http',
      typeStdio: '本地 stdio',
      hint: '凭据以明文存在 <DSH_HOME>/storages/；没有 OAuth，token 请填进请求头。',
      badJson: '{label} 不是合法 JSON',
      mustArray: '{label} 必须是 JSON 数组',
      httpFail: '服务端返回了非 JSON 内容（HTTP {status}）',
      kvKey: '名称',
      kvValue: '值',
      kvAdd: '添加一行',
      kvDel: '删除这一行',
    };

    const EN = {
      panel: 'MCP Manager',
      title: 'MCP Manager',
      add: 'Add',
      refresh: 'Refresh',
      empty: 'No MCP servers yet',
      edit: 'Edit',
      del: 'Delete',
      enable: 'Enable',
      disable: 'Disable',
      pending: 'not connected',
      delQ: 'Delete {name}?',
      cancel: 'Cancel',
      save: 'Save',
      close: 'Close',
      loading: 'Loading…',
      busy: 'Working…',
      namePh: 'Name',
      typeLbl: 'Type',
      urlPh: 'Endpoint URL',
      cmdPh: 'Command',
      argsPh: 'Arguments (JSON array)',
      envPh: 'Environment',
      headersPh: 'Headers',
      cwdPh: 'Working directory',
      notePh: 'Note',
      typeHttp: 'Remote streamable-http',
      typeStdio: 'Local stdio',
      hint: 'Credentials sit in plain text under <DSH_HOME>/storages/; there is no OAuth, put tokens in the headers.',
      badJson: '{label} is not valid JSON',
      mustArray: '{label} must be a JSON array',
      httpFail: 'Server returned a non-JSON response (HTTP {status})',
      kvKey: 'Name',
      kvValue: 'Value',
      kvAdd: 'Add row',
      kvDel: 'Remove this row',
    };

    function fill(template, vars) {
      return String(template == null ? '' : template).replace(/\{(\w+)\}/g, (whole, key) => (
        vars && Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : whole
      ));
    }

    /* 只用 --dsw-* 主题变量（跟宿主同一套），不写死任何颜色。 */
    const CSS = `
.mcpm { height:100%; overflow-y:auto; padding:24px 28px 40px; box-sizing:border-box;
  color:var(--dsw-alias-label-primary); font:inherit; font-size:14px; }
.mcpm-in { max-width:760px; margin:0 auto; }
.mcpm-bar { display:flex; align-items:center; gap:2px; margin-bottom:4px; }
.mcpm-h { margin:0; flex:1; font-size:14px; font-weight:600; letter-spacing:.01em; }
.mcpm-hint { margin:0 0 14px; font-size:13px; color:var(--dsw-alias-label-secondary); }
.mcpm-msg { margin:0 0 10px; font-size:13px; color:var(--dsw-alias-label-secondary); }
.mcpm-msg.err { color:var(--dsw-alias-state-error-primary); }
.mcpm-list { border-top:1px solid var(--dsw-alias-border-l2); }
.mcpm-row { display:grid; grid-template-columns:16px minmax(0,1fr) auto; align-items:center;
  gap:12px; padding:11px 12px; border-bottom:1px solid var(--dsw-alias-border-l2); }
.mcpm-row:hover { background:var(--dsw-alias-interactive-bg-hover); }
.mcpm-ck { width:16px; height:16px; margin:0; flex:none; cursor:pointer;
  accent-color:var(--dsw-alias-brand-primary); }
.mcpm-ck:disabled { opacity:.5; cursor:default; }
.mcpm-main { min-width:0; display:flex; flex-direction:column; gap:2px; }
.mcpm-top { display:flex; align-items:center; gap:8px; min-width:0; }
.mcpm-n { min-width:0; font-size:14px; font-weight:600; overflow:hidden; text-overflow:ellipsis;
  white-space:nowrap; }
.mcpm-tag { flex:none; padding:0 5px; font-size:11px; color:var(--dsw-alias-label-secondary);
  border:1px solid var(--dsw-alias-border-l2); border-radius:6px; }
.mcpm-pending { flex:none; font-size:12px; color:var(--dsw-alias-label-secondary); }
.mcpm-t { min-width:0; font-size:13px; color:var(--dsw-alias-label-secondary);
  overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.mcpm-a { display:flex; align-items:center; gap:2px; flex:none; }
.mcpm-tb { border:0; background:transparent; padding:6px 8px; font:inherit; font-size:13px;
  font-weight:400; line-height:1.25; color:var(--dsw-alias-label-secondary); border-radius:8px;
  cursor:pointer; transition:color .15s ease,background .15s ease; white-space:nowrap; }
.mcpm-tb:hover:not(:disabled) { background:var(--dsw-alias-interactive-bg-hover);
  color:var(--dsw-alias-label-primary); }
.mcpm-tb-warn:hover:not(:disabled) { color:var(--dsw-alias-state-error-primary); }
.mcpm-tb-accent { color:var(--dsw-alias-brand-primary); }
.mcpm-tb:disabled { opacity:.45; cursor:default; }
.mcpm-tb:focus-visible { outline:2px solid var(--dsw-alias-brand-primary); outline-offset:1px; }
.mcpm-empty { padding:18px 12px; font-size:13px; color:var(--dsw-alias-label-secondary); }
.mcpm-root { position:fixed; inset:0; z-index:1200; display:grid; place-items:center; padding:24px; }
.mcpm-mask { position:absolute; inset:0;
  background:var(--dsw-alias-bg-mask-1,var(--dsw-alias-bg-overlay)); }
.mcpm-dlg { position:relative; display:flex; flex-direction:column; font-size:14px;
  width:600px; max-width:calc(100vw - 48px); max-height:min(80vh,760px); overflow:hidden;
  border-radius:var(--dsw-radius-panel,20px); background:var(--dsw-alias-bg-layer-2);
  color:var(--dsw-alias-label-primary); box-shadow:var(--dsw-elevation-prominent,none); }
.mcpm-dlg-h { display:flex; flex:none; align-items:center; gap:8px; padding:20px 20px 12px 24px; }
.mcpm-dlg-t { margin:0; flex:1; min-width:0; font-size:15px; font-weight:600;
  overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.mcpm-dlg-b { display:flex; flex-direction:column; gap:14px; flex:1 1 auto; min-height:0;
  overflow-y:auto; overscroll-behavior:contain; padding:2px 24px 20px; }
.mcpm-dlg-f { display:flex; flex:none; align-items:center; justify-content:flex-end; gap:4px;
  padding:14px 24px 18px; border-top:1px solid var(--dsw-alias-border-l2); }
.mcpm-icon { width:28px; height:28px; flex:none; display:grid; place-items:center; border:0;
  background:transparent; border-radius:8px;
  color:var(--dsw-alias-label-secondary); cursor:pointer; font:inherit; font-size:15px; line-height:1; }
.mcpm-icon:hover:not(:disabled) { background:var(--dsw-alias-interactive-bg-hover);
  color:var(--dsw-alias-label-primary); }
.mcpm-icon:disabled { opacity:.45; cursor:default; }
.mcpm-f { display:flex; flex-direction:column; gap:5px; min-width:0; }
.mcpm-lbl { font-size:12px; color:var(--dsw-alias-label-secondary); }
.mcpm-line { display:flex; gap:14px; }
.mcpm-line > .mcpm-f { flex:1; }
.mcpm-i { font:inherit; font-size:13px; padding:0 10px; box-sizing:border-box; min-width:0;
  height:30px; border:1px solid var(--dsw-alias-border-l2);
  border-radius:8px; background:var(--dsw-alias-bg-base);
  color:var(--dsw-alias-label-primary); outline:none;
  transition:border-color .15s ease,box-shadow .15s ease; }
.mcpm-i:focus { border-color:var(--dsw-alias-brand-primary);
  box-shadow:0 0 0 3px color-mix(in srgb, var(--dsw-alias-brand-primary) 15%, transparent); }
.mcpm-i:disabled { opacity:.6; }
select.mcpm-i { padding:0 8px; cursor:pointer; }
.mcpm-kv { display:flex; flex-direction:column; gap:6px; }
.mcpm-kvr { display:flex; align-items:center; gap:8px; }
.mcpm-kvk { flex:0 0 40%; }
.mcpm-kvv { flex:1; }
.mcpm-strong { font-weight:600; }
`;

    /* ── 同源请求 ── */
    async function callApi(path, body) {
      const response = await fetch(API + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
        credentials: 'same-origin',
      });
      let payload;
      try {
        payload = await response.json();
      } catch {
        throw new Error(fill(EN.httpFail, { status: response.status }));
      }
      if (!response.ok || payload.ok === false) {
        throw new Error(payload.message || fill(EN.httpFail, { status: response.status }));
      }
      return payload;
    }

    function parseArray(text, label, tr) {
      const raw = String(text == null ? '' : text).trim();
      if (!raw) return undefined;
      let value;
      try {
        value = JSON.parse(raw);
      } catch {
        throw new Error(fill(tr('badJson'), { label }));
      }
      if (!Array.isArray(value)) throw new Error(fill(tr('mustArray'), { label }));
      return value.map(String);
    }

    /* headers / env 都是 Record<string,string>：内部用 {k,v} 行编辑，不让人手写 JSON。 */
    function toPairs(value) {
      if (Array.isArray(value)) {
        return value.map((row) => ({
          k: String(row && row.k != null ? row.k : ''),
          v: String(row && row.v != null ? row.v : ''),
        }));
      }
      if (value && typeof value === 'object') {
        return Object.keys(value).map((k) => ({ k, v: String(value[k] == null ? '' : value[k]) }));
      }
      return [];
    }

    function fromPairs(pairs) {
      const out = {};
      let count = 0;
      for (const row of Array.isArray(pairs) ? pairs : []) {
        const key = String(row && row.k != null ? row.k : '').trim();
        if (!key) continue;
        out[key] = String(row && row.v != null ? row.v : '');
        count += 1;
      }
      return count ? out : undefined;
    }

    /* ── 左侧栏图标（自带 SVG） ── */
    function McpManagerIcon(props) {
      const size = props && props.size ? props.size : 16;
      return h(
        'svg',
        {
          width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
          stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round',
          strokeLinejoin: 'round', 'aria-hidden': true, focusable: false,
          style: { display: 'block' },
        },
        h('rect', { x: 2.5, y: 3.5, width: 19, height: 7, rx: 2.2 }),
        h('rect', { x: 2.5, y: 13.5, width: 19, height: 7, rx: 2.2 }),
        h('path', { d: 'M6.2 7h.02M6.2 17h.02' }),
        h('path', { d: 'M14.5 7h3.4M14.5 17h3.4' }),
      );
    }

    /* ── 主面板 ── */
    const BLANK = {
      serverName: '', transport: 'streamable-http', url: '', headers: [],
      command: '', args: '', env: [], cwd: '', note: '',
    };

    function McpManagerPage(props) {
      const t = props && typeof props.t === 'function' ? props.t : (key) => (ZH[key] || key);

      const [servers, setServers] = React.useState([]);
      const [loading, setLoading] = React.useState(true);
      const [busy, setBusy] = React.useState(false);
      const [msg, setMsg] = React.useState(null);
      const [open, setOpen] = React.useState(false);
      const [editing, setEditing] = React.useState(false);
      const [form, setForm] = React.useState(BLANK);
      const [confirming, setConfirming] = React.useState(null);

      const apply = (data) => setServers(Array.isArray(data.servers) ? data.servers : []);

      const load = React.useCallback(async () => {
        setLoading(true);
        try {
          apply(await callApi('/list'));
        } catch (error) {
          setMsg({ err: true, text: error.message });
        } finally {
          setLoading(false);
        }
      }, []);

      React.useEffect(() => {
        let alive = true;
        callApi('/list')
          .then((data) => { if (alive) apply(data); })
          .catch((error) => { if (alive) setMsg({ err: true, text: error.message }); })
          .finally(() => { if (alive) setLoading(false); });
        return () => { alive = false; };
      }, []);

      const closeForm = () => {
        setOpen(false);
        setEditing(false);
        setForm(BLANK);
      };

      /* Esc 关闭弹窗 */
      React.useEffect(() => {
        if (!open) return undefined;
        const onKey = (event) => {
          if (event && event.key === 'Escape') closeForm();
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
      }, [open]);

      const setField = (key) => (event) => {
        const value = event && event.target ? event.target.value : event;
        setForm((prev) => Object.assign({}, prev, { [key]: value }));
      };

      const setPair = (field, index, side, value) => {
        setForm((prev) => {
          const rows = (Array.isArray(prev[field]) ? prev[field] : []).slice();
          const row = Object.assign({ k: '', v: '' }, rows[index] || {});
          row[side] = value;
          rows[index] = row;
          return Object.assign({}, prev, { [field]: rows });
        });
      };

      const addPair = (field) => {
        setForm((prev) => {
          const rows = (Array.isArray(prev[field]) ? prev[field] : []).slice();
          rows.push({ k: '', v: '' });
          return Object.assign({}, prev, { [field]: rows });
        });
      };

      const dropPair = (field, index) => {
        setForm((prev) => {
          const rows = (Array.isArray(prev[field]) ? prev[field] : []).slice();
          rows.splice(index, 1);
          return Object.assign({}, prev, { [field]: rows });
        });
      };

      const startAdd = () => {
        setForm(BLANK);
        setEditing(false);
        setConfirming(null);
        setMsg(null);
        setOpen(true);
      };

      const startEdit = (server) => {
        setForm({
          serverName: server.serverName,
          transport: server.transport === 'stdio' ? 'stdio' : 'streamable-http',
          url: server.url || '',
          headers: toPairs(server.headers),
          command: server.command || '',
          args: server.args ? JSON.stringify(server.args) : '',
          env: toPairs(server.env),
          cwd: server.cwd || '',
          note: server.note || '',
        });
        setEditing(true);
        setConfirming(null);
        setMsg(null);
        setOpen(true);
      };

      const submit = async () => {
        if (busy) return;
        setBusy(true);
        setMsg(null);
        try {
          const stdio = form.transport === 'stdio';
          const payload = {
            serverName: String(form.serverName || '').trim(),
            transport: form.transport,
            note: String(form.note || '').trim() || undefined,
          };
          if (stdio) {
            payload.command = String(form.command || '').trim();
            payload.args = parseArray(form.args, t('argsPh'), t);
            payload.env = fromPairs(form.env);
            payload.cwd = String(form.cwd || '').trim() || undefined;
          } else {
            payload.url = String(form.url || '').trim();
            payload.headers = fromPairs(form.headers);
          }
          const result = await callApi('/add', payload);
          closeForm();
          setMsg({ text: result.message });
          await load();
        } catch (error) {
          setMsg({ err: true, text: error.message });
        } finally {
          setBusy(false);
        }
      };

      const toggle = async (server) => {
        if (busy) return;
        setBusy(true);
        setMsg(null);
        try {
          const result = await callApi('/toggle', {
            serverName: server.serverName,
            enabled: server.enabled === false,
          });
          setMsg({ text: result.message });
          await load();
        } catch (error) {
          setMsg({ err: true, text: error.message });
        } finally {
          setBusy(false);
        }
      };

      const remove = async (server) => {
        if (busy) return;
        setBusy(true);
        setMsg(null);
        try {
          const result = await callApi('/remove', { serverName: server.serverName });
          setConfirming(null);
          setMsg({ err: result.ok === false, text: result.message });
          await load();
        } catch (error) {
          setMsg({ err: true, text: error.message });
        } finally {
          setBusy(false);
        }
      };

      /* ── 行：左边原生 checkbox 启停，右边文本按钮 ── */
      const rows = servers.map((server) => {
        const on = server.enabled !== false;
        const target = server.transport === 'stdio'
          ? [server.command].concat(server.args || []).join(' ')
          : (server.url || '');

        if (confirming === server.serverName) {
          return h(
            'div',
            { key: server.serverName, className: 'mcpm-row' },
            h('span', null),
            h('div', { className: 'mcpm-main' },
              h('div', { className: 'mcpm-t' }, fill(t('delQ'), { name: server.serverName }))),
            h('div', { className: 'mcpm-a' },
              h('button', {
                type: 'button', className: 'mcpm-tb', disabled: busy,
                onClick: () => setConfirming(null),
              }, t('cancel')),
              h('button', {
                type: 'button', className: 'mcpm-tb mcpm-tb-warn', disabled: busy,
                onClick: () => remove(server),
              }, t('del'))),
          );
        }

        return h(
          'div',
          { key: server.serverName, className: 'mcpm-row' },
          h('input', {
            type: 'checkbox',
            className: 'mcpm-ck',
            checked: on,
            disabled: busy,
            title: on ? t('disable') : t('enable'),
            'aria-label': `${server.serverName}: ${on ? t('disable') : t('enable')}`,
            onChange: () => toggle(server),
          }),
          h('div', { className: 'mcpm-main' },
            h('div', { className: 'mcpm-top' },
              h('span', { className: 'mcpm-n', title: target }, server.serverName),
              h('span', { className: 'mcpm-tag' }, server.transport === 'stdio' ? 'stdio' : 'http'),
              on && !server.live ? h('span', { className: 'mcpm-pending' }, t('pending')) : null),
            server.note
              ? h('div', { className: 'mcpm-t', title: server.note }, server.note)
              : null),
          h('div', { className: 'mcpm-a' },
            h('button', {
              type: 'button', className: 'mcpm-tb', disabled: busy,
              onClick: () => startEdit(server),
            }, t('edit')),
            h('button', {
              type: 'button', className: 'mcpm-tb mcpm-tb-warn', disabled: busy,
              onClick: () => setConfirming(server.serverName),
            }, t('del'))),
        );
      });

      /* ── 表单控件 ── */
      const field = (label, control) => h(
        'div',
        { className: 'mcpm-f' },
        h('span', { className: 'mcpm-lbl' }, label),
        control,
      );

      const input = (key, placeholder, extra) => h('input', Object.assign({
        className: 'mcpm-i',
        value: form[key],
        onChange: setField(key),
        placeholder: placeholder || '',
        'aria-label': placeholder || key,
        spellCheck: false,
        autoComplete: 'off',
      }, extra || {}));

      /* key-value 行编辑：一行一个「名称 = 值」，空名自动忽略。 */
      const kvEditor = (name, label) => {
        const pairs = Array.isArray(form[name]) ? form[name] : [];
        return h(
          'div',
          { className: 'mcpm-f' },
          h('span', { className: 'mcpm-lbl' }, label),
          h(
            'div',
            { className: 'mcpm-kv' },
            pairs.map((row, index) => h(
              'div',
              { key: String(index), className: 'mcpm-kvr' },
              h('input', {
                className: 'mcpm-i mcpm-kvk',
                value: row && row.k != null ? row.k : '',
                placeholder: t('kvKey'),
                'aria-label': t('kvKey'),
                spellCheck: false,
                autoComplete: 'off',
                onChange: (event) => setPair(name, index, 'k', event.target.value),
              }),
              h('input', {
                className: 'mcpm-i mcpm-kvv',
                value: row && row.v != null ? row.v : '',
                placeholder: t('kvValue'),
                'aria-label': t('kvValue'),
                spellCheck: false,
                autoComplete: 'off',
                onChange: (event) => setPair(name, index, 'v', event.target.value),
              }),
              h('button', {
                type: 'button',
                className: 'mcpm-icon',
                title: t('kvDel'),
                'aria-label': t('kvDel'),
                disabled: busy,
                onClick: () => dropPair(name, index),
              }, '×'),
            )),
            h('button', {
              type: 'button',
              className: 'mcpm-tb',
              style: { alignSelf: 'flex-start' },
              onClick: () => addPair(name),
            }, '+ ' + t('kvAdd')),
          ),
        );
      };

      /* ── 编辑弹窗：所有字段一次展开 ── */
      const stdio = form.transport === 'stdio';
      const dialog = open
        ? h(
          'div',
          { className: 'mcpm-root', role: 'presentation' },
          h('div', { className: 'mcpm-mask', onClick: closeForm }),
          h(
            'div',
            {
              className: 'mcpm-dlg',
              role: 'dialog',
              'aria-modal': 'true',
              'aria-label': editing ? t('edit') : t('add'),
              onClick: (event) => event.stopPropagation(),
            },
            h(
              'div',
              { className: 'mcpm-dlg-h' },
              h('h2', { className: 'mcpm-dlg-t', title: editing ? form.serverName : t('add') },
                editing ? `${t('edit')} · ${form.serverName}` : t('add')),
              h('button', {
                type: 'button', className: 'mcpm-icon', title: t('close'),
                'aria-label': t('close'), disabled: busy, onClick: closeForm,
              }, '×'),
            ),
            h(
              'div',
              { className: 'mcpm-dlg-b' },
              h(
                'div',
                { className: 'mcpm-line' },
                field(t('namePh'), input('serverName', t('namePh'), {
                  disabled: editing, autoFocus: !editing,
                })),
                field(t('typeLbl'), h('select', {
                  className: 'mcpm-i',
                  value: form.transport,
                  'aria-label': t('typeLbl'),
                  onChange: setField('transport'),
                },
                h('option', { value: 'streamable-http' }, t('typeHttp')),
                h('option', { value: 'stdio' }, t('typeStdio')))),
              ),
              stdio
                ? field(t('cmdPh'), input('command', 'npx -y @scope/pkg'))
                : field(t('urlPh'), input('url', 'https://mcp.example.com/mcp')),
              stdio ? field(t('argsPh'), input('args', '["-y","@scope/pkg"]')) : null,
              stdio ? field(t('cwdPh'), input('cwd', '')) : null,
              stdio ? kvEditor('env', t('envPh')) : kvEditor('headers', t('headersPh')),
              field(t('notePh'), input('note', '')),
              msg && msg.err
                ? h('div', { className: 'mcpm-msg err', role: 'alert' }, msg.text)
                : null,
            ),
            h(
              'div',
              { className: 'mcpm-dlg-f' },
              h('button', {
                type: 'button', className: 'mcpm-tb', disabled: busy, onClick: closeForm,
              }, t('cancel')),
              h('button', {
                type: 'button', className: 'mcpm-tb mcpm-tb-accent mcpm-strong', disabled: busy,
                onClick: submit,
              }, busy ? t('busy') : t('save')),
            ),
          ),
        )
        : null;

      return h(
        'div',
        { className: 'mcpm' },
        h('style', null, CSS),
        h(
          'div',
          { className: 'mcpm-in' },
          h(
            'div',
            { className: 'mcpm-bar' },
            h('h1', { className: 'mcpm-h' }, t('title')),
            h('button', {
              type: 'button', className: 'mcpm-tb mcpm-tb-accent', disabled: busy, onClick: startAdd,
            }, '+ ' + t('add')),
            h('button', {
              type: 'button', className: 'mcpm-tb', title: t('refresh'),
              disabled: loading || busy, onClick: () => { void load(); },
            }, '↻ ' + t('refresh')),
          ),
          h('div', { className: 'mcpm-hint' }, t('hint')),
          !open && msg
            ? h('div', { className: 'mcpm-msg' + (msg.err ? ' err' : ''), role: msg.err ? 'alert' : 'status' },
              msg.text)
            : null,
          h(
            'div',
            { className: 'mcpm-list' },
            loading
              ? h('div', { className: 'mcpm-empty' }, t('loading'))
              : servers.length === 0
                ? h('div', { className: 'mcpm-empty' }, t('empty'))
                : rows,
          ),
        ),
        dialog,
      );
    }

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
        /* 内置语言只有 zh / en，两个都注册，切换语言才跟得上。 */
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
      }, 'mcp-manager: dictionaries');

      const t = locale.bind(NS);

      /* 主区域整页：key 必须等于左侧栏入口的 id。 */
      ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main',
        key: PANEL_ID,
        locale: NS,
        inject: () => ({ t }),
      }, McpManagerPage));

      /* 左侧栏入口：点击后由框架按 id ↔ main.key 导航。 */
      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: 30,
        label: () => t('panel'),
      }, McpManagerIcon));
    }

    return { inject, apply };
  },
});
