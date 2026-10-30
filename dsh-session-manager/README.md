# Session Manager for DSH Web

精简版会话管理器：仅保留删除已归档会话的功能，参考自 [dsh-archive-manager](https://github.com/Jasonrale/dsh-archive-manager)。

## 功能

- 通过 `session_manager_delete` 工具删除已归档的会话（含完整的 agent 清理和日志目录删除）
- 可选的 Web UI：轻量确认对话框 + 成功提示

## 安装

```bash
pnpm add link:D:\Data\Projects\dsh-plugins\dsh-session-manager
```

在 `package.json` 中添加：
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
