# 面板视觉规范（双主题 / 层级 / 按钮 / 标签）

本文是插件控制台面板的常驻设计说明。改界面之前先读它；README 只讲用户可见功能，
这里描述的是**实现约束**——哪些类名、哪些层级、哪些颜色入口。

灵感来源是 Apple 官网的视觉语言：表面色切换代替装饰、单一蓝色强调、克制的 hairline、
展示字紧排。面板保留 13px 的紧凑正文密度（后台观测面板，不是落地页）。

---

## 1. 颜色与外观

### 1.1 三层 token

`lib/client.styles.js` 顶部定义全部颜色，组件规则**只允许**引用 `--pt-*`：

| 层 | 位置 | 允许出现 |
|---|---|---|
| 跟随 DSH | `.ptRoot` 自定义属性块 | `--dsw-alias-*`（带 fallback hex） |
| 明亮 | `.ptRoot[data-pt-theme=light]` | hex / rgba 字面量 |
| 夜间 | `.ptRoot[data-pt-theme=dark]` | hex / rgba 字面量 |

组件规则里出现 `--dsw-alias-*`、hex 或 `rgb()` 都算 bug：显式主题会有一块颜色不跟着变，
而默认的跟随模式看不出来。`scripts/verify-theme.mjs` 强制这条边界，并检查两套色板同名同量、
所有 `var(--pt-*)` 都有定义、两块都设置 `color-scheme`。

### 1.2 色板

| Token | 明亮 | 夜间 | 跟随 DSH |
|---|---|---|---|
| `--pt-canvas` | `#ffffff` | `#1d1d1f` | `transparent`（宿主画底） |
| `--pt-surface-1` | `#f5f5f7` | `#272729` | `bg-layer-2` |
| `--pt-surface-2` | `#ffffff` | `#2a2a2c` | `bg-layer-1` |
| `--pt-surface-3` | `#f0f0f2` | `#333336` | `bg-layer-3` |
| `--pt-line-1/2/3` | `#e0e0e3` / `#ececef` / `#d2d2d7` | `#3a3a3c` / `#2f2f31` / `#48484a` | `border-l3/l2/l4` |
| `--pt-text-1/2/3` | `#1d1d1f` / `#6e6e73` / `#86868b` | `#f5f5f7` / `#a1a1a6` / `#86868b` | `label-primary/secondary/tertiary` |
| `--pt-accent` | `#0066cc` | `#2997ff` | `state-business-primary` |
| `--pt-warn` | `#a86b12` | `#e8a33d` | `state-warn-primary` |
| `--pt-error` | `#d93b40` | `#f56b6b` | `state-error-primary` |
| `--pt-success` | `#0f9184` | `#30d158` | `state-success-primary` |
| `--pt-graph-node-fill` / `--pt-graph-node-line` | `#f5f5f7` / `#b9b9bf` | `#2f2f31` / `#5f5f64` | `bg-layer-2` / `border-l4` |
| `--pt-graph-edge` / `--pt-graph-label-bg` | `#7c7c82` / `#ffffff` | `#a1a1a6` / `#1d1d1f` | `label-tertiary` / `bg-layer-1` |

语义色只用于「警告 / 错误 / 成功」；数量、长度、序号不是状态，用文字色（`--pt-text-3`）。
搜索高亮的 6 个槽位也按主题各定义一份 `--pt-hit-N-bg/solid`。关系图另有一组图专用 token：
连线只有 1px 左右，借用 `--pt-line-*` 会在明亮主题下和画布糊在一起，所以节点填色、
节点描边、连线与边标签光晕各留一个入口。

### 1.3 外观选择

- 页头右侧三段控件：**跟随 DSH / 明亮 / 夜间**，`aria-label="面板外观"`，当前项 `aria-pressed`。
- 默认跟随。存储键 `dsh-plugin-console/theme`，只写 `localStorage`（浏览器本地偏好，不跨设备，
  不进宿主 storage domain）。读写失败一律退回跟随，不阻塞面板。
- 跟随模式不画 canvas、不覆盖 `color-scheme`：宿主切主题时面板自动跟着变。
  显式主题给 `.ptRoot` 画 canvas 并设置 `color-scheme`，原生 select / checkbox / 滚动条一致。
- 只作用于本面板，不改宿主整体主题。

---

## 2. 层级模型

```
L0 页面壳   .ptBar > .ptHead / .ptSearchRow / .ptTabs / .ptToolbar   +   .ptBody
L1a 分组头  .ptGroupHead（插件类别 / 会话工作区） · summary.ptOwnerHead（工具来源）
L1b 区块头  .ptSectionHead（静态） · details.ptSectionFold > summary.ptSectionHead（可折叠）
L2 容器     .ptCard（设置 / 动作组） · .ptFold（可折叠内容） · .ptSubBlocks（降一级）
L3 条目     .ptRow（可点击列表行） · .ptSurfaceRow（只读能力行） · details.ptFold > summary（内容行） · .ptToolCheck（勾选行）
```

规则：

- 列表分组头与区块头视觉一致（同样的字号、内边距、hairline、`▶`）；区别只是有没有计数与动作。
- 卡片不嵌卡片；折叠块最多嵌一层（消息 → 分段允许；插件贡献 → 注入文本 → 注册条件与源码也按这条处理）。
- 顶层区块下的子区块用 `.ptSubBlocks`（左侧竖线 + 降一级的 `.ptSubTitle`）。
- 区块说明只允许两种形式：一句 `.ptHint` / `.ptSectionNote`，或 `title` 悬停；不并列两句。
- 逐层 config 每层用 `.ptConfigLayer` 分块：层标题走 `.ptSubTitle`，内容用 `.ptConfigLayerBody`
  缩进并带 1px 竖线；键值用 `.ptConfigList`，键比值低一档颜色，层与层之间只隔一条 hairline。
- 悬停说明的文案与机制不变；可悬停的文字统一 `cursor:help`。

---

## 3. 按钮

| 类 | 用途 | 规格 |
|---|---|---|
| `.ptBtn` | 常规动作 | 28px、8px 圆角、hairline |
| `.ptBtn[data-tone=primary]` | 区块主动作 | 28px、全 pill、accent 实底 |
| `.ptBtn[data-tone=danger]` | 破坏性动作 | 28px、描边 + error 色；**实底只出现在确认弹窗** |
| `.ptBtn[data-tone=soft]` | 页面下一步（非提交） | pill、`--pt-accent-soft` 色调底 + accent 文字；悬停出 accent hairline |
| `.ptBtnLarge` | 页面主动作 | 36px、pill；只有 `data-tone=primary` 才是实底 |
| `.ptTextBtn` | 静默动作 | 12px、无边框 |
| `.ptChip` / `.ptSegBtn` | 筛选型切换 | 24px / 24px 分段 |

规则：

- 同一屏幕只允许一个 accent 实底主按钮。定制页的「预览定制结果」是次级大按钮，
  「应用并发送」才是唯一主按钮。
- 页面级的「下一步」如果不是提交（如上下文预演页底的「定制上下文」），用 `data-tone="soft"`
  的色调底，不用 accent 实底：只读页面上实底会抢掉内容本身。
- 破坏性动作排在最后，与主按钮之间留间距并隔一条 `.ptDivider`，不与主按钮同行。
- 工具条批量动作顺序固定：**折叠全部 → 展开全部**。
- 所有按钮 `:focus-visible` 用 `--pt-focus` 内描边，`:active` 统一 `scale(.97)`。

---

## 4. 标签与读数

- 左簇 `.ptTag` 只表达状态/关系：来源层、失败、全局层面禁用、禁用条件、缺服务、模式内挂载、被覆盖、
  subagent / 分叉 / 父会话、提示词定制状态、本模式替换/追加、置信度、影响条件、归属插件、
  lazy、有指导、未归属、注册作用域（其它作用域）、模板名、同名、无注册点、唯一来源。4 档颜色：
  中性 / 强调（`data-tone="user"`）/ 警告 / 错误。
- 右簇 `.ptEnd`（`shared.rowEnd(...)`）只放读数：`order N`、`54B`、`工具 12`、`调用 48`、
  `#3`、`3/12`、相对时间。**数字不再用胶囊**。
- 行内顺序固定：`[缩进][状态点][名称 + 副标题][左簇标签…][.ptEnd 读数…]`。
- 插件名称一律用组合行 id（`shared.shortName`），本地化标题只作副标题；同一个包会被
  挂载成多行（多个 preset、多个 MCP 客户端），标题与包名都会重名。
- 选择器用 `shared.selectField` 的多行 listbox，不用原生 `<select>`：选项按可用宽度换行，
  长插件 id / 工作区路径不出现省略号；菜单靠近视口右边界时改为右对齐。
- 标签不换行、名字 `min-width:0` 省略；一长串标签不能把名字挤成竖排。

---

## 5. 上下顺序

| 场景 | 顺序 |
|---|---|
| 详情页（插件 / 会话） | 身份 → 状态 → 来源与组合 → 依赖 → 贡献（注册项）→ 行为 → 观测（活动）→ 动作（控制） |
| 定制页 | 条件（模板 / 基准 / 工作区与权限）→ 内容编辑（逐段 → 追加 → 消息 → 工具）→ 派生预览 → 提交 → 危险清理 |
| 列表页 | 工具条筛选 → 诊断条（变更 / 通知）→ 分组列表 → 次级区块（模式预设） |
| 上下文预演页 | 条件 → 规模 → 内容标签 → 缺失说明 → 页底下一步 |
| 插件禁用预演页 | 被禁用的插件 → 连锁反应（会失去的工具与提示词 / 受影响的下游插件）→ 依赖关系图 → 配置与覆盖（覆盖链 / 配置对照 / 诊断）→ 证据与边界 |
| 能力面 | 段控件（技能 / 斜杠命令 / 网络）→ 条件（技能段：模式 + 工作区；命令段：工作区 + 会话 + 模式，选中会话时模式锁到该会话的预设；网络段：可输入的插件筛选 + 重读）→ 计数与降级说明 → 分组列表（技能折叠正文 / 命令行 / 网络：受控出口（整段折叠，内含 provider / MCP 列表）→ 直连出口（每个插件一个折叠容器，内含站点与调用点）→ 入站入口（每个插件一个折叠容器，内含全部路径））|

---

## 6. 逐页落点

| 文件 | 责任 |
|---|---|
| `client.styles.js` | token 三层 + 全部组件规则；新增类先在这里定义 |
| `client.shared.js` | `useThemePreference / normalizeTheme / THEMES / rowEnd / resultText` |
| `client.page.js` | 外观三段控件、`data-pt-theme`、页面壳 |
| `client.plugins.js` | 行标签/读数分区；详情本体已拆到 `client.plugin-detail.js`，这里只保留行与分组 |
| `client.plugin-detail.js` | 详情顺序与 divider、详情收起；贡献分工具 / 提示词段 / 运行时上下文 / 入口（源码扫描）/ 网络（源码扫描）五组，提示词贡献一律用 `details` 容器：一级注入文本，二级「何时展示 / 注册点与源码」短片段；有装配落点的容器在摘要里带「预演」动作 |
| `client.surface.js` | 能力面外壳、三段控件与条件栏；网络段条件栏带可输入的插件筛选（聚焦展开、输入过滤、关闭显示当前项），段内容按需注入 |
| `client.surface-store.js` | 能力面条件（工作区 / 模式 / 会话）与按段懒取；ticket 防竞态，失败保留原因 |
| `client.surface-skills.js` | 技能段：计数、来源层级标签（项目 / 本机 / DSH / 配置 / 运行时，原始 source 保留在提示与展开项）、使用方式标签、展开后的文件位置（无 path 时退回资源目录）/ source（层级词 + 原始桶）/ provider / 归属插件（没有归属行时说明「本 skill 不由插件注册」，运行时注册另注明未定位到注册包）、正文按需完整读取、单条正文内的文本检索、发现不完整警告 |
| `client.surface-commands.js` | 命令段：活会话 / 预设 scope / 源码扫描三种证据分开显示，技能入口与 client 贡献缺失说明；技能入口没有归属行时用来源层级标签（项目 / 本机 / DSH / 配置 / 运行时），不写「未归属」 |
| `client.surface-network.js` | 网络段：受控出口（整段折叠，内含 provider / MCP，显示插件名）→ 直连出口（每个插件一个可折叠容器，容器内按站点列全部调用点，调用点标出模块名与文件行号，未提供受控通道是推断（仅第三方插件，内置包与本控制台不标））→ 入站入口（每个插件一个可折叠容器，列全部路由）；三段统一用 `ptSectionFold`，插件分组用 `ptOwnerGroup`；标签按性质分色：类别中性、证据强调、推断与缺失警告、故障错误（`failed`）；一个条目只挂一个类别标签，数量走 `ptCount` 文本；按插件筛选时只收窄视图并显示筛选条 |
| `client.sessions.js` | 行标签/读数分区、分组头右簇 |
| `client.session-detail.js` | 详情收起、绑定区的读/写分隔、子块标题 |
| `client.tools.js` | 两段区块折叠头、来源分组头、工具行读数 |
| `client.preview.js` | 条件/规模两行、内容区块头、折叠行右簇、跳转来源说明与未命中原因 |
| `client.disable-preview.js` | 插件禁用预演：被禁用的插件、连锁反应（失去项 + 下游插件）、配置与覆盖、证据与边界 |
| `client.impact-tree.js` | 上下游关系树：完整下游影响链路（host 闭包）+ 上游提供者（只展开 2 层）+ 以选中节点为中心的完整依赖链路（两侧递归到底）；去重、环检测、名称折行；把树摊成与几何无关的图模型（节点 / 尺寸 / 去重边）后交给布局与走线，纯函数，不碰 React。两种几何共用同一份模型，所以换布局不换关系；焦点路径（`focusPathOf`）也在这里算：能到达它的 + 它 + 它可达的节点，边取两端都落在集合里的那些 |
| `client.graph-layout.js` | 分层布局引擎：破环、以目标为中心的双向最长路分层、dummy 拆长边、median + transpose 排序、Brandes-Köpf 层内坐标、端口与通道分配。不认插件语义 |
| `client.graph-net.js` | 网状布局引擎：无向跳数 → 目标距离（`w = d⁻²`）→ 以分层坐标为初值的局部应力优化（SMACOF 局部形式，单调收敛）→ 矩形去重叠 → 画布边界。无随机数，同一输入永远同一张图 |
| `client.graph-route.js` | 走线：分层走正交折线（端口与通道还原，4px 圆角、箭头、嵌字缺口；竖段落端点自己的 x 跨度、横段落层间空隙，因此不穿方块）；网状走二次贝塞尔（两端陷进方块 8px，按节点尺寸为单位的法向偏移试探、采样否决撞框或越出画布的候选，标签用底色块压住文字）。候选全被否决时退回一条采样过的直线：**每条边都必须画得出来**，否则节点会变成没有连边的孤岛 |
| `client.relation-graph.js` | 依赖关系图画布：固定视口内 Ctrl + 滚轮缩放、拖拽平移，节点只显示插件名并把状态收进悬浮提示；连线箭头统一为「提供者 → 消费者」。两条独立的轴：数据口径（影响图 / 完整链路图）与几何（分层 / 网状），都是 `.ptSeg` 分段控件，且**浮在画布右上角的 `.ptGraphOverlay` 里**而不是区块头——按钮放在它作用的东西上，拖动图形时也不跟着跑。可一键隐藏非树边。点击节点或边高亮经过它的整条路径（命中保持原色、其余降透明度），再点一次或点空白取消；跳转插件页收进节点右键菜单（Shift+F10 / ContextMenu 同样可达），菜单里还有同一个聚焦开关。浮层、scrim 与菜单都是 stage 的兄弟、坐标统一用视口像素——stage 的 `translate + scale` 只作用于画布。线型图例（服务依赖 / 子行 / config 引用（推断） / 同一批声明里的另一条路径）固定在左下角 `.ptGraphLegend`，同样不随画布缩放，且只列当前画出来的线型，少于两种线型不显示 |
| `client.preview-messages.js` / `client.influence.js` / `client.preview-raw.js` | 右簇、区块头、窗口规则、上下文未命中提示 |
| `client.editor.js` / `client.editor-messages.js` / `client.template-card.js` | 区块头、按钮层级、卡片语法 |

窗口规则：整份请求正文（system / tools / messages）用 `.ptWindow`（320px，内部滚动）；
单段原文不限高（随折叠展开全文），避免两层滚动条。

破坏性清理在定制页底部默认收起成一行居中小字（`details.ptCleanupFold` + CSS 三角），
展开才是清理卡片，再点一次收起；危险操作不常驻版面。定制页的「预览定制结果」进入独立视图，
用 `.ptPageTitle` 标明「提示词定制结果预览」，不再用一句小字解释它是只读预览。

---

## 7. 维护检查

```powershell
npm run verify          # 24 项；含 verify:theme
node scripts/verify-theme.mjs
```

`verify:theme` 会红的情况：

- 组件规则里写了 `--dsw-alias-*` 或颜色字面量；
- 明亮 / 夜间色板 token 名不一致；
- 引用了未定义的 `--pt-*`；
- 显式主题缺 `color-scheme`；
- 外观控件 / 右簇 / 区块头的类名被删。

`verify:views` 另外守着：默认跟随 DSH、三段外观控件、详情分区顺序、唯一实底主按钮、
窗口数量、绑定区竖排等结构性约定。改结构时同步改断言，不能删断言了事。
