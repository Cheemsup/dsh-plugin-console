# CLAUDE.md

本文件为 Claude Code 在本仓库中工作时提供指引。

## 项目概览

`@cheemsup/dsh-plugin-console` 是 DeepSeek Harness（DSH）的侧边栏「插件控制台」，定位是插件运行控制台：
展示当前 profile 组合出的 Cordis 插件树、会话的插件来源、工具归属与上下文预演（在指定工作区、
模式、权限预设下，新会话的第一条消息发出前模型真正会收到的内容），并支持把改写后的提示词/工具集
作为模板应用到一个会话。树只是插件页的组织方式；控制台还包含会话 / 上下文预演 /
插件禁用预演 / 插件能力面四页与可撤销的
会话级调节。插件能力面汇总一个部署与每个插件提供的五类事实：工具、上下文注入、
技能目录、斜杠命令、网络能力与连接。代码分两半，加载方式完全不同：

- **host 半**（`lib/index.js`，Node ESM）：被 DSH 直接 `import`，在 Cordis 里注册 18 条
  鉴权 Fetch 路由（`/api/plugin-console/*`）。
- **client 半**（`lib/client.js`，浏览器 lazy-CJS）：由宿主模块系统
  `@deepseek-ai/dsh-client-modules` 加载，注册侧边栏 slot 与主面板。

绝大多数数据是**只读运行时事实**（`ctx.loader.entries()`、`pluginManager.listBundles()`、
`agentPresets`、`tools.view()`、`systemPrompt.assemble()`、session log）。唯一的写路径是模板/
掩码/控制审计，落在 storage domain `plugin_console_templates`；本插件不改 profile 的
`cordis.patch.yml`，也不直接启停插件（委托 `pluginManager`）。

## 常用命令

```powershell
npm run verify                 # 全部 28 项自检（提交前应全绿）
npm run verify:views           # 单跑一项；等价于 node scripts/verify-views.mjs
node scripts/verify-views.mjs  # 任一脚本都可直接跑
```

没有构建、lint、依赖安装步骤：仓库零依赖，自检脚本是普通 Node ESM，不依赖测试框架。
唯一的 peer dependency 是宿主提供的 `@deepseek-ai/cordis`（`~4.1.0`）。

> `scripts/`（28 项自检与夹具）只在本地保留，已由 `.gitignore` 排除，不随仓库发布。

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
lib/index.js → host/routes/* → host/templates/* + host/*
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
  能力面把「注册标签」也列为独立证据：入站路由可能来自 effect label，也可能是源码里的
  path 字面量，两者分开标注。
- 提示词注册点：源码扫描除了名字，还记录 `sites`（file / line / receiver / receiverKind）。
  `receiverKind` 是启发式推断，只用来判断「这个名字是否在本作用域注册」；插件页据此决定
  是否提供「预演」动作——预演只装配 global + preset scope，子代理 / 会话 /
  条件作用域（例如 `dsh-subagent` 的 `subagent:delegation`）没有首请求落点，只展开本地
  注册点。按需源码片段走 `POST /api/plugin-console/registration-site`：只接受模块名，
  宿主解析包目录，只读包内 `lib/**/*.{js,mjs,cjs}`，有大小 / 行数上限，失败返回 `found:false`。
- 插件禁用预演（`host/disable-preview.js` + `host/config-layers.js` + `host/patch-config.js`）：
  影响面是派生计算——子行按 `entryId` 前缀级联（preset 等 EntryGroup owner 也有子行）；
  依赖链按「可用提供者全部不可用」迭代到不动点（已禁用提供者重载后不注册，不计入可用），
  父行受阻时子行一并不可用，条目距离取最后失效的必需服务 + 1，路径沿 `viaEntryId` 回溯，
  环靠距离递减收敛；owner 为空进「未归属」（注册表里有这一项、源码扫描定位不到），名字扫得到
  但全局注册表没有则单独进「不在全局注册表」（会话内/条件注册，不计入失去），消费者自己也在
  不可用集合里时不报 pending。链结论的语义是「禁用并重载/重启后」。
  配置分层把 bundle / profile / home / 启动覆盖的 patch 声明与 Loader 生效值并排展示，bundle
  patch 读不到就标「不可读」并给原因；patch 合并语义未公开，诊断只陈述「生效值里有没有 / 与某层
  是否不同」，原因一律标推断。页面只读，执行禁用仍走控制区。
- 依赖方向由 `scripts/verify-structure.mjs` 强制：`host/routes/*` 只解析参数、调服务、序列化，
  不写业务；`host/templates/*` 不碰 HTTP；`host/*` 顶层不反向 import 上层。
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
- 能力面的技能 / 命令 / 网络（`host/surface-*.js` + `host/routes/surface-*.js`）按需懒取，
  不进快照；工具与上下文注入只读快照。只有源码扫描的名字随 `registrations` 进快照。
  技能走 `ctx.skills.snapshot()/get()`（工作区 + 预设 scope，3 秒上限）；
  命令以活会话 `commands.list(agent)` 为主；会话已结束（或没指定会话）时用
  `acquireScope()` 的 scope key 只读回退（标 `offContract`），冷会话另标 `sessionState:
  'inactive'`——会话 scope 读不到，结果只是「它记录的模式 + 工作区」的近似；再退源码扫描；
  会话候选只列选中工作区内的全部会话（含未运行的；未归属工作区的会话兜底进默认工作区，
  标「未归属」），模式在选中会话时锁到该会话的预设；
  网络只读 `llm/web.listProviders()`、
  `mcpManager.list()`、effect label 与源码里的 path 字面量；另用 `host/network-scan.js`
  的规则表补直接请求（导入绑定 + 调用形状：fetch / axios / node:http / WebSocket / 配置键），
  该结果是静态证据，单独标注「不证明请求发生过」。不拦截 fetch、不返回 endpoint /
  headers / env / args。归属索引（`host/surface-owners.js`）除了 Loader 行，还会把只出现在
  模式声明里的模块补成 `rowId = 模块名` 的合成行，与插件页的合成条目同一个 id、同一份
  贡献判定（`source-scan.js` 的 `hasContributions`）；否则同一个插件会在能力面显示
  「未归属」、在插件页却有条目。
- 不反射私有符号（`ctx.intercept()` / `ctx.isolate()` 不展示）。

### client 半

client 半**没有打包器**，只能用一个包内 chunk 机制：每个文件是
`window.__ModuleLoader__.load({ id: '@cheemsup/dsh-plugin-console', chunk: 'client.<name>.js', factory })`，
入口用 `require.async('./client.<name>.js')` 取。`client.js` 先并发加载全部 chunk，最后加载
`client.page.js`（它的工厂依赖前面所有实例）；`styles.ensureStyles()` 在挂面板前执行。

- `client.page.js` 只组装页面级 state 与派生值；状态本身按失败语义拆在
  `client.store.js`（快照 + 模板 CRUD/应用/开关）、`client.editor-store.js`（草稿、基线与
  工作区/权限条件）、`client.preview-store.js`（预演条件）、`client.surface-store.js`
  （能力面条件与按段懒取）等 store hook 里；活动 / 控制 / 会话影响 / 禁用预演也各有一份。
  定制页的工作区/权限条件 **与预演页互相独立**，不共用状态；预演页的「首请求」与定制页的
  「定制结果」是两份请求。
  视图是纯函数（`renderSessionsView(vc)`），`page.js` 把「状态 + setter + 动作 + memo 派生值」
  装进 `vc` 传给视图，视图可脱离页面单独渲染——`verify-views.mjs` 依赖这点。插件详情本体在
  `client.plugin-detail.js`（从 `client.plugins.js` 拆出，避免撞 1000 行上限）。运行时归属不在
  详情里重复读取，由「能力贡献」各子块头的「在插件能力面查看」按 owner 收窄。
- 共享实例（`draft`、`cleanup`、`editor` 等）在 `client.js` 里组装一次再注入，避免不同
  chunk 各自造一份状态。
- 视图只有五个标签 + 定制编辑器：插件 / 会话 / 上下文预演 / 插件禁用预演 / 插件能力面。
  插件能力面内部五段：工具 / 上下文注入 / 技能 / 斜杠命令 / 网络，默认工具段。
  工具段读快照的工具表，并读活动路由补调用读数；上下文注入只读快照；技能 / 命令 / 网络
  按需懒取。五段共用一份
  `focusOwner`（Loader 行 id，`__none` = 未归属）与 `focusName`：owner 跨段保留、
  name 切段清空；统一插件选择器在页面壳，各段只提供自己的附加条件。
  上下文注入段按插件折叠：外层一个可折叠区块 + 每个插件一个 `ptOwnerGroup`
  （默认展开），与工具段 / 网络段同一套容器和「折叠全部 / 展开全部」。
  条件与按段懒取在 `client.surface-store.js`，段视图分别在
  `client.surface-tools.js` / `client.surface-prompts.js` / `client.surface-skills.js` /
  `client.surface-commands.js` / `client.surface-network.js`。
  提示词贡献的模型与折叠视图在 `client.prompt-contribution.js`，插件详情与上下文注入段
  共用同一份，标签、落点判断与文案不得各写一套。
  网络段按「受控出口 → 直连出口 → 入站入口」组织，三段统一整段折叠，
  规模只放在各段段头（不另立顶部总览与证据图例，每一行自带证据标签）；直连与入站内部再按插件分组，
  每个插件一个 `ptOwnerGroup`（内部列全部端点），条件栏的统一插件选择器只收窄视图，不重读路由。
  页面组织原则是「一页一个问题」，界面约束见 `docs/design-ui.md`，改 UI 前先读。
- 插件行右簇在「工具 / 注入 / 技能 / 命令 / 网络行为」读数里回答「源码里写了多少」：
  技能与命令优先用能力面 owner 摘要（按当前工作区 / 模式 / 会话，进入插件页时取一次；
  provider 发现的技能没有源码注册名），摘要不可用或该 owner 为 0 时退回源码扫描的
  `runtimeSkills` / `commands`；网络行为 = `networkSites` 数量，悬停只写
  「源码扫描发现 N 处网络行为」。数量回答「源码里写了多少 / 当前条件下归属多少」，
  悬停要说清来源；零值不显示，避免每行都拖一串 0。
- 「网络（源码扫描）」这类能力条目在插件详情里要能看全：源码扫描不再按条数截断
  prompt 注册站点与网络调用点，客户端也不再只渲染前 30 条；注册点源码片段同样不按站点数
  截断。单包文件数 / 字节数、单段文本 / 片段的字符数仍是扫描耗时与响应体积的工程上限，
  不在这条「条目数量」约束里。
- 插件详情的贡献合并在一个「能力贡献」区块：只列这个插件真的有的能力，空能力连
  子块标题都不出；工具 / 上下文注入 / 技能与命令 / 网络四个子块，每个子块头带计数与
  「在插件能力面查看」跳转（落到对应段并只显示本插件）；上下文注入里的名字点击落到
  上下文注入段并按名字收窄，「预演」仍是次级动作。工具与技能 / 命令用 chip，提示词用
  `details`，网络同时列注册名与源码调用点（`host/network-scan.js` 的静态证据）。
  四个子块各自的「在插件能力面查看」落到对应段并按 owner 收窄——那里同时展示源码扫描
  与运行时归属；详情只讲快照 / 源码扫描的事实，运行时归属不在详情里重复读取或另设入口。
  能力面的 owner chip 反向跳插件页；
  目标在收起的类别里会展开，目标不在快照里时插件页显示缺失说明，不静默失手。
- 「运行时登记」段展示 Cordis fiber 的 effect 类别：与「能力贡献」重叠的注册工具 /
  注入提示词 / 注册命令 / 提供服务 / Web / 模型适配只保留一行计数；事件监听、界面槽位、
  Remote 方法等独有类别才作为标签，避免同一份名单出现两次。
  提示词贡献一律渲染成 `details` 容器（一级看注入文本，二级看「何时展示 / 注册点与源码」）；
  只有「本作用域注册且当前装配里
  有落点」的容器在摘要里提供「预演」动作。名字级索引恰好只有本行、站点全在本作用域且名字
  不是模板时标 `唯一来源`。预演页的来源标签统一为「可能的插件来源，点击跳转查看」，
  不在标签上区分同名碰撞。`gotoSection(name, kind, origin)` 把种类与来源传给预演，预演据此
  选标签页并在顶部说明跳转来源；`focusKind` / `focusOrigin` 与 `focusSection` 同生命周期，
  切视图时一起清空。
- 禁用预演的图分两种断言：**影响图**只读 host 闭包（目标 + 随父行失效的子行 + 受阻条目），
  不画上游、不画 config 引用；**完整图**沿 `provides`/`requires` 展开全量上下游，并把生成树
  丢掉的服务边作为 cross edge 补回来，同时附加子行与 config 引用（推断，点线）。节点身份统一为
  `entryId`，`rowId` 只用于展示与点击跳转；所有 cross edge 都画出，不因数量省略，完整图可一键
  隐藏非树边（显式操作，不是默认省略）。
- 图的几何拆成三个 chunk，并且**布局与数据是两条独立的轴**（数据：影响图 / 完整链路图；
  几何：分层 / 网状）。上层 `client.impact-tree.js` 先把树摊成与几何无关的图模型（节点 /
  尺寸 / 去重边），两种几何拿的是同一份模型——这是「换布局不换连边」的前提，自检里有专门
  断言。几何引擎：
  - `client.graph-layout.js`：破环 → 以目标为中心的双向最长路分层 → dummy → median 扫描 +
    transpose 排序 → Brandes-Köpf 坐标 + 端口/通道分配。**方向自上而下**：上游在上、目标居中、
    下游在下。层内顺序决定交叉数、坐标只负责把顺序画直——两者不要再混在一起调。
  - `client.graph-net.js`：无向跳数 → 目标距离（`w = d⁻²`）→ 以分层坐标为初值的局部应力优化
    （SMACOF 局部形式，式 12，单调收敛）→ 矩形去重叠。**无随机数**，同一输入永远同一张图；
    初值复用分层结果，所以省掉抖动、也更稳定。
  - `client.graph-route.js`：分层走正交折线（长边经 dummy 逐层直下，横段只落在层间空隙、
    竖段只落在端点自己的 x 跨度内，所以不穿方块；同一空隙的通道按 x 区间复用）；网状走
    二次贝塞尔（按法向偏移试探、采样否决撞框的候选，避障是启发式不是保证）。偏移按
    **节点尺寸**取倍数而不是绝对像素；弯出画布的候选取样会被裁断，直接否决。所有候选
    都被否决时退回**采样过的直线**——退回成两点折线会让 `d` 为空，稠密图里就是成片
    「没有连边的孤岛」。网状这边边行必须始终可画，`verify-chunks` 有硬断言。
- 关系图的控件（数据分段、布局分段、非树边开关、缩放）**放在画布右上角的 `.ptGraphOverlay`
  浮层里**，不在区块头：它们只作用于这张图，且浮层不随平移缩放移动。空态没有浮层。
  线型图例是左下角的 `.ptGraphLegend`，与浮层同级（同样不随画布变换）、`pointer-events:none`：
  它只列**当前画出来的**线型（隐藏非树边后长虚线退场），少于两种线型就不显示。
- 关系图的路径聚焦：点击节点或边，按「经过它的所有有向路径」高亮——上游可达 + 自身 +
  下游可达，边取两端都落在集合里的那些（纯函数 `focusPathOf`，在 `impact-tree.js`）；
  其余节点与边只降透明度，**不动几何**，高亮不该让图重排。再点同一个元素或点画布空白取消。
  可达性只走当前画出来的边：隐藏非树边时不算它。左键已用于聚焦，**节点跳转插件页改为
  右键菜单**（Shift+F10 / ContextMenu 同样可达），菜单里同时提供同一个聚焦开关。焦点按
  `{ kind, key }` 存进页面状态；换目标/换数据口径时清空，换几何（分层/网状）时保留。
- 关系图的坐标只有一套：**视口像素**（`.ptGraphViewport` 的内边距盒）。stage 自己带
  `translate + scale`，浮层、scrim、右键菜单都是它的**兄弟**而不是子节点，菜单的锚点由
  节点布局坐标经同一组数字正向换算；菜单开着时 Ctrl + 滚轮不缩放，否则菜单会和节点错开。

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