# dsh-plugins

DeepSeek Harness（DSH）的本地插件集合：两个手写的**面板 + 对话工具**插件，源码即产物，没有构建步骤。

| 包名 | 目录 | 版本 | 作用 |
|---|---|---|---|
| `@local/mcp-manager` | [`dsh-mcp-manager/`](dsh-mcp-manager/README.md) | 2.2.0 | 管理你手写的 MCP 服务器清单，投射成 loader 条目；左侧栏管理页 + `mcp_list` / `mcp_add` / `mcp_remove` / `mcp_toggle` |
| `@local/skill-manager` | [`dsh-skill-manager/`](dsh-skill-manager/README.md) | 1.1.0 | 技能工作台：启停、只读查看 `SKILL.md`、打开目录、删除、**拖文件夹进来即导入**；左侧栏面板 + `skill_manager_*` 四个工具 |

两个插件互不依赖，可以单独安装。细节（界面结构、配置项、HTTP 路由、存储格式、已知边界）都在各自的 README 里，本文件只讲**这个仓库整体**怎么装、怎么改。

## 目录结构

```
dsh-plugins/
├── dsh-mcp-manager/
│   ├── package.json          # 包名、exports、dsh.bundle / dsh.client 声明
│   ├── cordis.patch.yml      # 插进 profile 的一行 Loader 配置
│   ├── icon.svg              # 左侧栏图标
│   ├── lib/
│   │   ├── index.js          # 宿主侧：服务、工具、HTTP 路由、存储
│   │   └── client.js         # 浏览器侧：面板 UI（原生 DOM，无构建）
│   ├── locale/{en,zh}.json   # 双语字典
│   └── README.md
└── dsh-skill-manager/        # 同上结构
    └── test/import.test.mjs  # 拖拽导入的回归测试（node test/import.test.mjs）
```

约定：**每个子目录是一个独立 npm 包**，`@local/*` 是本地包的 scope，`private: true`，不发布到 registry。仓库根目录刻意不放 `package.json`／`pnpm-workspace.yaml`——DSH 是按**单个包目录**做 `link:` 的，根目录再多一层 workspace 只会让 `@deepseek-ai/*` 这类宿主 peer 的解析路径变得不可预期。

## 安装到 DSH profile

以 desktop profile（`%USERPROFILE%\.dsh\profiles\desktop`）为例。

**1. 在 profile 的 `package.json` 里加两条 link 依赖**

```json
{
  "dependencies": {
    "@local/mcp-manager": "link:D:/Data/Projects/dsh-plugins/dsh-mcp-manager",
    "@local/skill-manager": "link:D:/Data/Projects/dsh-plugins/dsh-skill-manager"
  }
}
```

**2. 在同一个 `package.json` 的 `dsh.profile.bundles` 里登记**

```json
{
  "dsh": {
    "profile": {
      "bundles": [
        "@local/mcp-manager",
        "@local/skill-manager"
      ]
    }
  }
}
```

**3. 装链接**

```bash
cd %USERPROFILE%\.dsh\profiles\desktop
pnpm install
```

装完 `node_modules/@local/` 下会出现两个指向本仓库子目录的 junction。**重启 DSH**，左侧栏就会出现两个入口。

> 依赖从哪来：插件自己不装依赖。`react`、`@deepseek-ai/dsh-client-*` 这些都由宿主（profile 的 `node_modules`）提供。所以本仓库没有 `node_modules`，也不该有。
>
> ⚠️ **宿主侧的 `lib/index.js` 不要 import 任何非 `node:` 包**（包括 `@deepseek-ai/schemastery`）。
> 插件是按 `link:` 挂进 profile 的，Node 解析裸导入时会先 `realpath` 到本仓库的真实路径
> （`E:\Projects\Git\dsh-plugins\dsh-mcp-manager\lib\index.js`），再从**那里**往上找 `node_modules`；
> 而本仓库刻意不带 `node_modules`，profile 里的包**不在**这条查找链上，于是插件激活时报
> `ERR_MODULE_NOT_FOUND`。声明 `peerDependencies` 也救不了：profile 的 `pnpm-workspace.yaml`
> 里 `autoInstallPeers: false`，peer 根本不会被落盘。
>
> 需要配置校验就用运行时归一化（见 `dsh-skill-manager` / `dsh-mcp-manager` 的 `normalizeConfig`），
> **不要导出 schemastery 的 `Config`**。客户端半边（`lib/client.js`）不受影响——它跑在浏览器里，
> 由宿主的 `dsh.client.inject` 机制解析。

## 开发

- **没有构建、没有打包。** `lib/*.js` 就是原生 ESM 产物，改完直接生效。
- **改 `lib/client.js`**：客户端 bundle 靠轮询文件 mtime 热更新，几秒内生效；不生效就刷新页面。
- **改 `lib/index.js`**：宿主侧代码在进程里已加载，**必须重启 DSH**。
- **换包名**：`dsh-client-modules` 会把「这个包不是客户端包」的否定结论缓存到进程重启为止，改代码、开关插件、刷新页面都无效。真要改名，新 specifier = 新缓存 key，或重启 DSH。
- **CSS**：只用 `--dsw-alias-*` / `--dsw-*` 主题令牌，跟随宿主明暗主题；类名一律带插件前缀（`mcp-*` / `skm-*`），避免撞上宿主全局样式。

## 安全与隐私

- 两个插件的 HTTP 路由**都不带鉴权**（`ctx.webServer.register` 本身不做鉴权），所以各自实现**回环守卫**：`remoteAddress` 与 `Host` 都必须指向本机，否则 403。
- MCP Manager 把 `headers` / `env`（含 API key、token）**明文**存在 `%USERPROFILE%\.dsh\storages\mcp_manager.json`。分享或截图前记得打码，这个文件也不要进版本库。
- Skill Manager 的删除会**穿透 junction/符号链接**，所以 `%USERPROFILE%\.dsh\skills\` 下建议放**副本**，不要把 git 里维护的源目录直接链进去。

## 版本库约定

- 默认分支 `main`，提交信息用祈使句短句（`add ...` / `fix ...` / `docs: ...`）。
- 不提交 `node_modules/`、日志、`*.local`；`.gitignore` 已覆盖。
- 文本文件统一 LF（`.gitattributes` 已固定），避免 Windows 换行把整份 diff 变成全红。

## 许可

[MIT](LICENSE)。

## 迁移记录

2026-10-25 从 `C:\Users\Gove2\Desktop\PlayGround\dsh-plugins` 迁到 `D:\Data\Projects\dsh-plugins`，同时初始化 git 成为独立项目。

开发期用过的一次性验证脚本（`.team/skilltest`、`.team/skillcheck` 等）留在原 PlayGround 工作区，**没有**随仓库迁移；所以 `dsh-skill-manager/README.md` 末尾「测试」一节里的命令在本仓库里跑不通，那些脚本属于当时的临时环境。
