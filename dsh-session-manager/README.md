# dsh-session-manager

为 DSH Web 添加「删除已归档会话」功能，入口在侧边栏会话列表每个会话的「⋮」菜单中。

## 功能

- **侧边栏菜单项**：每个会话的 `...` 菜单底部出现红色「删除」按钮，点击后弹出确认对话框
- **对话工具**：`session_manager_delete` 工具，供 Agent 程序化删除已归档会话
- **完整清理**：终止 agent → 删除持久化日志目录（含 Windows 文件锁定重试）→ 从工作区 detach

## 删除流程

```
验证 sessionId
  → 检查是否已归档
  → 等待活跃 agent 终止（1s 有界超时）
  → 删除日志目录（EBUSY/EPERM 重试 4 次）
  → detachSession + 清理 archivedSessionIds
```

## 架构

| 文件 | 职责 |
|---|---|
| `lib/index.js` | 宿主半边：HTTP 路由 + `session_manager_delete` 工具 |
| `lib/client.js` | 客户端半边：React 组件，注入 `sidebar.workspaces.session.menu.item` slot |
| `cordis.patch.yml` | Cordis 注入配置，挂载 `/api/session-manager` 路由前缀 |
| `locale/zh.json` / `en.json` | 多语言字典 |
| `icon.svg` | 插件图标 |

## 安装

在 profile 的 `package.json` 中添加：

```json
{
  "dependencies": {
    "@local/dsh-session-manager": "link:D:/Data/Projects/dsh-plugins/dsh-session-manager"
  },
  "dsh": {
    "profile": {
      "bundles": ["@local/dsh-session-manager"]
    }
  }
}
```

然后运行：

```bash
pnpm install --dir ~/.dsh/profiles/desktop
```

或直接在 DSH 插件管理器中启用 `@local/dsh-session-manager`。

## 配置

通过 `cordis.patch.yml` 传入：

```yaml
- insert:
    - id: session-manager
      name: '@local/dsh-session-manager'
      config:
        routePrefix: /api/session-manager   # 默认值，可省略
```

## 参考

基于 [dsh-archive-manager](https://github.com/Jasonrale/dsh-archive-manager) 的精简版，仅保留删除会话逻辑。
