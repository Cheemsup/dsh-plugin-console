# CLAUDE.md

本文件为 Claude Code 在本仓库中工作时提供指引。

## 项目概览

`@cheemsup/dsh-plugin-console` 是 DeepSeek Harness（DSH）的侧边栏「插件控制台」，定位是插件运行控制台：
展示当前 profile 组合出的 Cordis 插件树、会话的插件来源、工具归属与上下文预演（在指定工作区、
模式、权限预设下，新会话的第一条消息发出前模型真正会收到的内容），并支持把改写后的提示词/工具集
作为模板应用到一个会话。树只是插件页的组织方式；控制台还包含会话 / 工具 / 上下文预演 /
插件禁用预演四页与可撤销的
会话级调节。代码分两半，加载方式完全不同：

- **host 半**（`lib/index.js`，Node ESM）：被 DSH 直接 `import`，在 Cordis 里注册 13 条
  鉴权 Fetch 路由（`/api/plugin-console/*`）。
- **client 半**（`lib/client.js`，浏览器 lazy-CJS）：由宿主模块系统
  `@deepseek-ai/dsh-client-modules` 加载，注册侧边栏 slot 与主面板。

绝大多数数据是**只读运行时事实**（`ctx.loader.entries()`、`pluginManager.listBundles()`、
`agentPresets`、`tools.view()`、`systemPrompt.assemble()`、session log）。唯一的写路径是模板/
掩码/控制审计，落在 storage domain `plugin_console_templates`；本插件不改 profile 的
`cordis.patch.yml`，也不直接启停插件（委托 `pluginManager`）。

## 常用命令

```powershell
npm run verify                 # 全部 24 项自检（当前状态下应全绿）
npm run verify:views           # 单跑一项；等价于 node scripts/verify-views.mjs
node scripts/verify-views.mjs  # 任一脚本都可直接跑
```

没有构建、lint、依赖安装步骤：仓库零依赖，自检脚本是普通 Node ESM，不依赖测试框架。
唯一的 peer dependency 是宿主提供的 `@deepseek-ai/cordis`（`~4.1.0`）。

> `scripts/`（24 项自检与夹具）只在本地保留，已由 `.gitignore` 排除，不随仓库发布。

安装/卸载到某个 profile（真机调试）：

```powershell
dsh plugin --profile <profile> add file:<本目录绝对路径>
dsh plugin --profile <profile> remove @cheemsup/dsh-plugin-console
```

`cordis.patch.yml` 声明了 bundle 插入行（`id: plugin-console`、`name: '@cheemsup/dsh-plugin-console'`），
行 id 必须固定，浏览器半才会挂到这一行上。

## 架构

### host 半

```
lib/index.js → routes/* → templates/* + host/*
```

`lib/index.js` 只做三件事：`inject: ['loader']`；在 connection 到来**之前**安装模板继承与
掩码继承监听（顺序不能反，掩码要合在模板物化的 base 之上）；然后 `ctx.inject(['connection'])`
挂载全部路由。任何 collector 失败都降级，不能让快照整体失败。

- `host/snapshot.js` 是采集编排：把 entries、bundle 层、patch 扫描、模式、会话、工具、提示词、
  归属拼成一份 JSON。快照是**按需投影**（进入面板取一次，之后手动或 30 秒静默刷新），
  不订阅 Loader 变化。
- 数据可信度分四级，界面与文档都要求区分：运行时事实（Loader / 注册表 / session log）、
  声明值（preset 组合清单）、文件事实（`host/patch-config.js` 读到的 patch config）、源码扫描
  （`host/source-scan.js`）；推导与推断必须单独标注。注册表不记 owner，所以工具
  与提示词段的「谁注册的」只能扫包源码；扫不到就标「未归属」并写原因，不硬凑近似结果。
- 提示词注册点：源码扫描除了名字，还记录 `sites`（file / line / receiver / receiverKind）。
  `receiverKind` 是启发式推断，只用来判断「这个名字是否在本作用域注册」；插件页据此决定
  是否提供「在上下文预演中查看」——预演只装配 global + preset scope，子代理 / 会话 /
  条件作用域（例如 `dsh-subagent` 的 `subagent:delegation`）没有首请求落点，只展开本地
  注册点。按需源码片段走 `POST /api/plugin-console/registration-site`：只接受模块名，
  宿主解析包目录，只读包内 `lib/**/*.js`，有大小 / 行数上限，失败返回 `found:false`。
- 插件禁用预演（`host/disable-preview.js` + `host/config-layers.js` + `host/patch-config.js`）：
  影响面是派生计算——分组按 `entryId` 前缀级联；依赖链按「所需服务的提供者全部不可用」迭代到
  不动点，条目距离取最后失效的必需服务 + 1，路径沿 `viaEntryId` 回溯，环靠距离递减收敛；owner
  为空进「未归属」（注册表里有这一项、源码扫描定位不到），名字扫得到但全局注册表没有则单独进
  「不在全局注册表」（会话内/条件注册，不计入失去），消费者自己也在不可用集合里时不报 pending。
  链结论的语义是「禁用并重载/重启后」。
  配置分层把 bundle / profile / home / 启动覆盖的 patch 声明与 Loader 生效值并排展示，bundle
  patch 读不到就标「不可读」并给原因；patch 合并语义未公开，诊断只陈述「生效值里有没有 / 与某层
  是否不同」，原因一律标推断。页面只读，执行禁用仍走控制区。
- 依赖方向由 `scripts/verify-structure.mjs` 强制：`routes/*` 只解析参数、调服务、序列化，
  不写业务；`templates/*` 不碰 HTTP；`host/*` 不反向 import 上层。
- 模板持久化：`templates/revisions/manifests/activations/masks/operations` 六张表。
  `manifests` 是会话创建时的不可变快照，`activations` 是独立可变开关（**没有记录 = 启用**）。
  存储域不可用时降级为内存表，绝不写 sidecar 文件。
- 物化（`templates/materialize.js`）把 recipe 注册到 agent scope：撤销必须 `await` 后再注册
  同名段落；`restrict({deny})` 只提交 `tools.view(scope).restrictableNames` 认识的名字；
  `complete: true` 的独占提示词段覆盖时要保留 `complete`，追加段落要折进该段。
  runtime-context 用 scoped `systemPrompt.context()` 逐段覆盖（沿用 order/required、
  `interpolate:false`），整条隐藏用 `suppressRuntimeContext()`；pre-step 注入的消息由
  `templates/message-overlay.js` 在 `prepend:true` 的监听器里改写，只改 `content`、保留
  `source/id`（baselineIdentity 与目录 digest 都靠它）。
- 不反射私有符号（`ctx.intercept()` / `ctx.isolate()` 不展示）。

### client 半

client 半**没有打包器**，只能用一个包内 chunk 机制：每个文件是
`window.__ModuleLoader__.load({ id: '@cheemsup/dsh-plugin-console', chunk: 'client.<name>.js', factory })`，
入口用 `require.async('./client.<name>.js')` 取。`client.js` 先并发加载全部 chunk，最后加载
`client.page.js`（它的工厂依赖前面所有实例）；`styles.ensureStyles()` 在挂面板前执行。

- `client.page.js` 是唯一组装 React state 的地方；状态本身按失败语义拆在
  `client.store.js`（快照 + 模板 CRUD/应用/开关）、`client.editor-store.js`（草稿、基线与
  工作区/权限条件）、`client.preview-store.js`（预演条件）三个 hook 里。定制页的工作区/权限条件
  **与预演页互相独立**，不共用状态；预演页的「首请求」与定制页的「定制结果」是两份请求。
  视图是纯函数（`renderSessionsView(vc)`），`page.js` 把「状态 + setter + 动作 + memo 派生值」
  装进 `vc` 传给视图，视图可脱离页面单独渲染——`verify-views.mjs` 依赖这点。
- 共享实例（`draft`、`cleanup`、`editor` 等）在 `client.js` 里组装一次再注入，避免不同
  chunk 各自造一份状态。
- 视图只有五个标签 + 定制编辑器：插件 / 会话 / 工具 / 上下文预演 / 插件禁用预演。页面组织原则是「一页一个问题」，
  界面约束见 `docs/design-ui.md`，改 UI 前先读。
- 插件详情的贡献分三组：工具 / 提示词段 / 运行时上下文。提示词贡献一律渲染成 `details`
  容器（一级看注入文本，二级看「何时展示 / 注册点与源码」）；只有「本作用域注册且当前装配里
  有落点」的容器在摘要里提供「预演」动作。名字级索引恰好只有本行、站点全在本作用域且名字
  不是模板时标 `唯一来源`。预演页的来源标签统一为「可能的插件来源，点击跳转查看」，
  不在标签上区分同名碰撞。`gotoSection(name, kind, origin)` 把种类与来源传给预演，预演据此
  选标签页并在顶部说明跳转来源；`focusKind` / `focusOrigin` 与 `focusSection` 同生命周期，
  切视图时一起清空。

## 修改时必须遵守的硬约束

这些都由 `npm run verify` 强制，破坏即红：

- 单文件 ≤ 1000 行；host 依赖方向不能反向。
- 无死导入（`verify-imports.mjs`）；client chunk 里不能有「解构了但没用」的名字
  （`verify-destructuring.mjs`，以 `_` 开头除外）。
- 新增 client chunk 必须同时：文件名匹配 `client.<name>.js`、注册 id 为包名且带 `chunk`
  字段、在 `client.js` 里 `require.async`、写进 `package.json` 的 `files`（client 文件是显式
  列表，host 是 `lib/host/**/*.js` 通配）。
- 新增 host 路由：路径常量放 `host/constants.js`，路由文件保持只做 HTTP 适配，在
  `lib/index.js` 的 `mount(...)` 里挂载并给 effect label。
- 内置插件页的显示名与简介来自包内 `locale/<language>.json` 的 `meta.title` /
  `meta.description`（宿主 `readPluginMeta` 读取；缺省时标题退回包名，也就是原始 id）。
  `locale/en.json` 是语言表基线，语言文件必须同时写进 `package.json` 的 `exports`
  （`./locale/*.json`）与 `files`；`verify-bundle.mjs` 强制这三件事。图标同理走 manifest
  的 `icon` 字段，路径留在包内并随包发布。
- 颜色只走 `--pt-*`：组件规则里不许出现 `--dsw-alias-*`、hex 或 `rgb()`；宿主 token 只出现在
  `.ptRoot` 的「跟随 DSH」映射块，明亮/夜间两套色板在 `[data-pt-theme]` 块里（`verify:theme` 强制）。
  `pt` 是历史样式命名空间，产品改名时特意没有跟着改成 `pc`，不要顺手重命名。
  读数用 `shared.rowEnd(...)` 放右簇，数量不用胶囊；区块头用 `.ptGroupHead` / `.ptSectionHead`，
  不新增第三种标题语法。设计规范见 `docs/design-ui.md`。
- 行为变更要同步补/改对应 `scripts/verify-*.mjs`；不能只改实现让旧断言失效。

## 文档与语言

- `README.md` / `README_en.md` 是面向用户的中英文安装与功能说明，两份同步维护；截图编号与清单
  见 `docs/images/README.md`。实现细节、数据口径与设计约束以本文件与 `docs/` 为准。
- 代码注释、UI 文案、文档均使用中文，保持这一风格；注释解释「为什么」和反直觉的约束，
  不要复述代码在做什么。