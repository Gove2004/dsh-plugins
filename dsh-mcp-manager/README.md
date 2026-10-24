# MCP Manager（`@local/mcp-manager`）

把一堆 MCP 服务器配置集中管起来：**只管你自己填的**，没有内置连接器目录、没有远程 registry、没有「推荐」货架。

它做三件事：

1. **存储**一份纯 JSON 清单：`<DSH_HOME>/storages/mcp_manager.json`。
2. 把清单里的每条记录**投射**成一条 `@deepseek-ai/dsh-mcp-client` loader 条目 —— MCP 工具不是本插件实现的，连上之后工具以 `mcp__<serverName>__<tool>` 出现在模型工具列表里。
3. 提供**两个入口，共用同一套 core**：对话工具（`mcp_list` / `mcp_add` / `mcp_remove` / `mcp_toggle`）和**左侧栏图形界面**。

## 界面（简约版）

左侧栏一个「服务器机架」图标（`MCP Manager`），点开是管理页。整个页面就是一列：

```
[✓]  github  http                                 编辑  删除
     GitHub 官方
[ ]  fs  stdio                                    编辑  删除
     本地文件
```

- **一行一台**：左边原生 checkbox 直接启停，中间两行（名称 + 类型标签 / **只有备注**，没备注就不占第二行），
  右边只有「编辑 / 删除」文本按钮；链接和命令不铺在列表里（鼠标悬停在名称上才显示）
  - 勾选且已连上 = 正常；勾选但还没连上会多一个「未连接」小字；未勾选 = 停用
- 顶栏：标题在左，右边是两个对称的带符号文本按钮 —— `+ 新增`（品牌色）和 `↻ 刷新`
- **编辑是一个弹窗**（`position:fixed` + grid 居中 + `--dsw-alias-bg-mask-1` 遮罩 + `--dsw-radius-panel` 圆角）：
  标题栏固定（右侧 28×28 的 × 图标按钮）、正文独立滚动、页脚用 `border-l2` 分隔线钉在底部，
  字段一次全展开并带标签；按 Esc 或点遮罩关闭
- 视觉全部对齐原生面板（实测宿主的数值）：**正文 14px / 次要 13px / 标签 12px**、按钮 13px 高 29px 圆角 8px、
  输入框 30px 高、弹窗 `--dsw-radius-panel`（28px）、分隔线 `--dsw-alias-border-l2`、
  hover 用 `--dsw-alias-interactive-bg-hover`、按钮是 `border:0;background:transparent` 的文本按钮
- `headers` / `env` 用 **key-value 行编辑**（一行一个「名称 = 值」，`+ 添加一行`），不用手写 JSON；
  只有 `args` 是 JSON 数组
- 删除是**行内二次确认**（该行变成「删除 fs？　删除　取消」），不弹浏览器对话框

界面**不打包、不 require 任何 `@deepseek-ai/dsh-client-*` 包**：只用 `react` + `--dsw-alias-*`
主题变量，所以跟随宿主明暗主题，也不会因为宿主内部组件改名而整块崩掉。数据走同源 HTTP
`/api/mcp-manager/*`，因此**不需要写死端口**（DSH 每次启动端口都变）。

> 只有左侧栏入口这一条通道；早期那个 `/ui` 独立兜底页已经删掉了。

## 配置

`cordis.patch.yml` 里一行 Loader 配置：

| 键 | 默认 | 说明 |
|---|---|---|
| `entryPrefix` | `mcp` | 投射出的 loader 条目 id 前缀：`<prefix>-<serverName>` |
| `storageFile` | `mcp_manager.json` | 相对 `<DSH_HOME>/storages/` |
| `routePrefix` | `/api/mcp-manager` | 图形界面用的 HTTP 路由前缀 |

## 对话工具

| 工具 | 作用 |
|---|---|
| `mcp_list` | 列出所有服务器（名称、传输方式、启停、是否已加载、目标、备注） |
| `mcp_add` | 新增/更新（按 `serverName` upsert） |
| `mcp_remove` | 删除（同时摘掉 loader 条目） |
| `mcp_toggle` | 启停 |

`serverName` 必须匹配 `/^[A-Za-z0-9_-]{1,32}$/`（它会变成工具名的前缀）。

## HTTP 路由（图形界面用）

| 方法 | 路径 | 作用 |
|---|---|---|
| `POST` | `/list` | 列出 |
| `POST` | `/add` | 新增/更新 |
| `POST` | `/remove` | 删除 |
| `POST` | `/toggle` | 启停 |

**这些路由不带鉴权**（`ctx.webServer.register` 本身不做鉴权），所以插件自己做**回环守卫**：
`remoteAddress` 和 `Host` 必须都是本机回环，否则 403。方法不对返回 405。

## 存储格式

```json
{
  "version": 1,
  "servers": [
    {
      "serverName": "context7",
      "transport": "streamable-http",
      "enabled": true,
      "note": "最新库文档",
      "url": "https://mcp.context7.com/mcp",
      "headers": { "Authorization": "Bearer ctx7sk-..." }
    }
  ]
}
```

### ⚠️ 凭据是明文

`headers`（以及 stdio 的 `env`）以**明文**存在上面那个文件里，管理页点「编辑」也会明文显示。
分享这个文件或截图时记得打码。

## 排错

- **侧栏没有图标**：先看插件是否启用；再确认 `package.json` 里 `dsh.client.platform === 'web'`
  且 `exports` 有 `./client`。
- **改了 `lib/client.js` 页面没变**：客户端 bundle 靠轮询文件 mtime 热更新，一般几秒内生效；
  不生效就刷新页面。
- **包被判定成「非客户端包」且再也不会加载**：`dsh-client-modules` 会把「非客户端包」这个
  **否定结论缓存到进程重启为止**，改代码、开关插件、刷新页面都无效。唯一解法是**换一个包名**
  重装（新 specifier = 新缓存 key），或重启 DSH。
- **工具没出现**：`mcp_list` 里看那一行是「已加载」还是「未加载」；未加载通常是 URL/命令写错，
  或者远端返回了 401。

## 安全边界（本插件不做的）

不做内置连接器目录、不做远程 registry、不做 OAuth PKCE、不做连通性预检、不做 scope 隔离。
它只是一个「清单 + 投射器 + 一个页面」。
