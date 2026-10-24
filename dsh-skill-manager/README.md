# Skill Manager（`@local/skill-manager`）

把 DSH 里的技能收进一个能看清、能量出成本的台面：启停、只读查看 SKILL.md、打开所在文件夹、删除。

左侧栏一本合上的书（书脊 + 垂下的书签），点开是整页面板；另外注册 4 个对话工具。

## 面板

```
Skill Manager                             📂 浏览   ↻ 刷新
我的技能可启停 / 查看 / 删除 · 内置技能随构建提供，只读（在 app.asar 内）
我的技能  4
──────────────────────────────────────────────────────────────
☑  send-email        Send emails directly via SMTP…       🗑
☑  make-tutorial     Create professional-grade…           🗑
内置技能  9
──────────────────────────────────────────────────────────────
☑  office            Create, edit, inspect…               🗑
```

- **勾选框 = 模型可见**（`disable-model-invocation` 取反）。我的技能可点；内置技能显示为已勾选且禁止交互——文件改不了，所以开关也不该是能点的。
- **点名称或描述** → 只读查看整份 `SKILL.md`。内置技能的正文由技能服务提供，frontmatter 按清单重建（弹窗里会注明）。
- **📂 浏览**（顶部）：打开技能根目录。内置技能打在 `app.asar` 里没有目录可开，所以不放在每行。
- **🗑 每行都有**；我的技能可点（删整个目录），内置技能置灰不可点。
- 分组标题只带个数（`我的技能 4` / `内置技能 9`），两组共用的说明合并成顶栏那一行。
- 面板**不编辑正文**：改写交给文件夹里的编辑器，或者在对话里用 `skill_manager_save`。

## 它不做什么（重要）

**不给内置技能加真的开关。** 内置技能是打包在 `app.asar` 里的只读文件，而技能服务（`ctx.skills`）只有 `list/snapshot/get/register`，**没有 disable API**。所以内置行只有一个禁用状态的勾选框，不是假按钮。

## 真启停怎么成立的

本插件向 `ctx.skills` 注册自己的 provider，扫

- `<工作区>/.dsh/skills`（rank 100，项目级）
- `<DSH_HOME>/skills`（rank 400，用户级）

各一层：`<name>/SKILL.md` 或 `<name>.md`。这两个目录里的技能**由本插件的 provider 提供**，内容直接读文件，所以改 frontmatter 立刻改变可见性——不是 UI 状态。

## frontmatter 语义（对齐官方 provider）

```yaml
---
name: pdf-report                       # 必填，kebab-case
description: 把 PDF 报告整理成结论摘要      # 必填，会进模型看到的技能目录
whenToUse: 用户丢来一份 PDF 并要求要点时     # 可选
disable-model-invocation: true          # 出现在这里 = 模型看不到
user-invocable: false                   # 出现在这里 = /命令不可用
---
```

布尔值接受 `true/false`、`yes/no`、`on/off`、`1/0`（不区分大小写）。**拼写非法会让整个技能被丢弃**（官方 provider 的行为），本插件把这种情况显示出来而不是静默吞掉。

默认两路都开启；"开启"就是把对应的键删掉——所以文件里不出现这两个键时最干净。

## 资源目录（带 scripts/ 和 references/ 的技能）

provider 会给每个技能带上 `resourceBase`（目录型 = 技能目录，单文件型 = 它所在目录）。框架加载技能时会自动渲染成：

```
Base directory for this skill: C:\Users\Gove2\.dsh\skills\send-email
Resolve relative paths mentioned by this skill against the base directory…
```

所以正文里写 `scripts/send_mail.py` 没问题。已实测（`send-email`）。

## 对话工具

- `skill_manager_list` —— 清单：名称、来源、模型可见性、是否可 `/调用`
- `skill_manager_save` —— 新建或覆盖技能（面板里没有这个入口了，写文件走这里或你的编辑器）
- `skill_manager_toggle` —— `surface=model|user` 控制可见性
- `skill_manager_delete` —— 删除

## HTTP 路由（面板用它，均需本机回环）

```
GET|POST /api/skill-manager/list
POST     /api/skill-manager/read     {name}        → {kind:'file'|'bundled', raw, path, revealable}
POST     /api/skill-manager/reveal   {scope:'root'} → 打开技能根目录
POST     /api/skill-manager/reveal   {name}        → 打开该技能目录（内置技能返回 400）
POST     /api/skill-manager/save     {…}
POST     /api/skill-manager/toggle   {name, surface, value}
POST     /api/skill-manager/delete   {name}
```

## 不算 token

面板不做任何 token 统计：没有每行的估算，也没有合计。技能的 `description` 确实会进系统提示，但这个口径是猜的（CJK 近似 1 字 1 token），猜出来的数字只会误导，所以整个去掉了——宿主也不再计算，不留死代码。

## 安装技能：复制，别用目录联接

扫描器支持 junction/符号链接（`Dirent` 对链接只报 `isSymbolicLink`，会再 `stat` 一次补真实类型；删除链接时只摘重解析点，不递归删真身），但**推荐复制**进 `C:\Users\Gove2\.dsh\skills\<name>\`：面板的删除会穿透链接，git 里维护的源目录容易被误伤。

## 已知边界

- **preset 层的技能不在清单里。** 面板读的是全局层（`snapshot({cwd})`），像 `cordis-plugin-development` 这类挂在 agent preset 上的技能只在装载该 preset 的会话里可见。
- **没有文件监听。** 外部编辑器改了技能文件，点一下「刷新」；本插件自己的写操作会立即失效缓存。
- **`skill_manager_save` 会重写整个 frontmatter**，未知键（如 `metadata`）只在 `toggle` 时原样保留，`save` 后会被规范成上表四个字段。
- 内置技能既不能编辑也不能删除；同名新建会被拒绝（含与内置重名）。
- 不导出 schemastery 的 `Config`：link 安装按真实路径解析时找不到 `@deepseek-ai/schemastery`，会激活失败。配置在运行时归一化。
- **类名必须带前缀。** 第一版按钮用了裸的 `pri` / `danger`，和宿主全局 CSS 撞上会导致「新建」和「刷新」字体不一致。现在所有类名都是 `skm-*`，按钮基础类还显式钉死 `font-size:13px; font-weight:400`。

## 配置

```yaml
config:
  routePrefix: /api/skill-manager   # 路由前缀
  skillRoot: ''                     # 留空 = <DSH_HOME>/skills
  projectRoot: true                 # 是否扫 <工作区>/.dsh/skills
```

## 测试

> 下面两个脚本属于开发期的临时验证目录（原 PlayGround 工作区的 `.team/`），**未随本仓库迁移**，本仓库不含测试。

- `.team/skilltest/test.mjs`（58 项）：provider 注册、frontmatter 解析/序列化往返、启停真写盘、未知键保留、非法布尔值剔除、kebab 校验、重名拒绝、单文件技能、只读查看（文件与内置两条分支）、打开目录的内置拒绝、回环守卫与 405
- `.team/skillcheck/check.mjs`（34 项）：双语字典对齐、CSS 只用 `--dsw-*` 令牌、slot id/key 配对、图标与清单一致性

```bash
node .team/skilltest/test.mjs
node .team/skillcheck/check.mjs
```
