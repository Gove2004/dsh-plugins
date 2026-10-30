/**
 * @local/dsh-session-manager —— 客户端半边
 *
 * 在每个会话的「...」菜单中注入删除项。
 * 点击后弹出确认对话框，确认后调用 POST /api/session-manager/delete。
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-session-manager',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'sessionManager';
    const API = '/api/session-manager';

    /* ── 样式：使用 DSW token，对齐侧边栏菜单风格 ── */
    const CSS = `
.dsm-modal-overlay{position:fixed;inset:0;z-index:1100;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center}
.dsm-modal{background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);border-radius:16px;width:380px;max-width:90vw;box-shadow:var(--dsw-shadow-lv3);overflow:hidden}
.dsm-modal-title{padding:16px 20px 8px;font-size:16px;font-weight:600;color:var(--dsw-alias-label-primary);margin:0}
.dsm-modal-desc{padding:0 20px 4px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary);margin:0}
.dsm-modal-status{padding:8px 20px;font-size:12px;color:var(--dsw-alias-state-error-primary)}
.dsm-modal-footer{display:flex;justify-content:flex-end;gap:8px;padding:0 20px 16px}
.dsm-btn{display:inline-flex;align-items:center;gap:5px;height:30px;padding:0 14px;font-size:13px;font-weight:500;border:0;border-radius:8px;cursor:pointer;font-family:inherit;transition:background .15s}
.dsm-btn-cancel{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsm-btn-cancel:hover:not(:disabled){background:var(--dsw-alias-border-l2)}
.dsm-btn-del{background:var(--dsw-alias-state-error-primary);color:#fff}
.dsm-btn-del:hover:not(:disabled){opacity:.88}
.dsm-btn:disabled{opacity:.4;cursor:not-allowed}
.dsm-menu-item{display:inline-flex;align-items:center;gap:6px;width:100%;height:28px;padding:0 8px;font-size:13px;font-family:inherit;color:var(--dsw-alias-state-error-primary);background:none;border:none;border-radius:6px;cursor:pointer;text-align:left;transition:background .12s}
.dsm-menu-item:hover{background:rgba(220,50,50,.12)}
.dsm-menu-icon{flex:none;display:inline-flex;align-items:center;justify-content:center}
`;

    /* ── 确认弹窗 ── */
    function ConfirmModal(props) {
      const { sessionId, sessionTitle, t, onClose, onDone } = props;
      const [busy, setBusy] = React.useState(false);
      const [err, setErr] = React.useState('');

      async function handleDelete() {
        setBusy(true);
        setErr('');
        try {
          const resp = await fetch(`${API}/delete`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId }),
          });
          const data = await resp.json().catch(() => ({ ok: false, message: `HTTP ${resp.status}` }));
          if (!resp.ok || !data.ok) throw new Error(data.message || `HTTP ${resp.status}`);
          onDone(sessionId);
        } catch (e) {
          setErr(e.message);
        } finally {
          setBusy(false);
        }
      }

      return h('div', {
        className: 'dsm-modal-overlay',
        onClick: (e) => { if (e.target === e.currentTarget) onClose(); },
      },
        h('div', {
          className: 'dsm-modal',
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': t('confirmTitle'),
        },
          h('h2', { className: 'dsm-modal-title' }, t('confirmTitle')),
          h('p', { className: 'dsm-modal-desc' },
            `${t('confirmDesc')} "${sessionTitle || sessionId}"`),
          err ? h('p', { className: 'dsm-modal-status' }, err) : null,
          h('div', { className: 'dsm-modal-footer' },
            h('button', {
              className: 'dsm-btn dsm-btn-cancel',
              onClick: onClose,
              disabled: busy,
            }, t('cancel')),
            h('button', {
              className: 'dsm-btn dsm-btn-del',
              onClick: handleDelete,
              disabled: busy,
            }, busy ? t('deleting') : t('confirm')))));
    }

    /* ── 注册 ── */
    const inject = ['slots', 'locale'];

    function apply(ctx) {
      const slots = ctx.slots;
      const locale = ctx.get('locale');

      let t = (key) => key;
      if (locale) {
        const zh = {
          delete: '删除',
          confirmTitle: '确认删除会话',
          confirmDesc: '将永久删除会话',
          cancel: '取消',
          confirm: '删除',
          deleting: '删除中…',
        };
        const en = {
          delete: 'delete',
          confirmTitle: 'Delete Session',
          confirmDesc: 'This permanently deletes session',
          cancel: 'Cancel',
          confirm: 'Delete',
          deleting: 'Deleting…',
        };
        try { locale.register(NS, 'zh', zh); } catch {}
        try { locale.register(NS, 'en', en); } catch {}
        t = locale.bind(NS);
      }

      // 注入样式
      ctx.effect(() => {
        const el = document.createElement('style');
        el.textContent = CSS;
        document.head.appendChild(el);
        return () => { try { el.remove(); } catch {} };
      }, 'session-manager: styles');

      // 在侧边栏会话列表的「...」菜单中注册删除项
      slots.inject('sidebar.workspaces.session.menu.item', () => slots.register({
        name: 'sidebar.workspaces.session.menu.item',
        id: 'session-delete',
        order: 999,
        label: () => t('delete'),
      }, function DeleteMenuItem(props) {
        const { sessionId, sessionTitle } = props;
        const [open, setOpen] = React.useState(false);

        return h(React.Fragment, null,
          h('button', {
            type: 'button',
            className: 'dsm-menu-item',
            onClick: () => setOpen(true),
            title: t('delete'),
            'aria-label': `${t('delete')}：${sessionTitle || sessionId}`,
          },
            h('svg', {
              className: 'dsm-menu-icon',
              viewBox: '0 0 16 16', width: 14, height: 14,
              fill: 'none', stroke: 'currentColor',
              strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round',
            },
              h('path', { d: 'M2 4h12' }),
              h('path', { d: 'M5 4V3a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1' }),
              h('path', { d: 'M3 4l.5 9a2 2 0 0 0 2 2h5a2 2 0 0 0 2-2L13 4' })
            ),
            h('span', null, t('delete'))),
          open ? h(ConfirmModal, {
            sessionId, sessionTitle, onClose: () => setOpen(false),
            onDone: () => setOpen(false),
          }) : null);
      }));
    }

    return { inject, apply };
  },
});
