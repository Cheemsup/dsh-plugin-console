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
L3 条目     .ptRow（列表行） · details.ptFold > summary（内容行） · .ptToolCheck（勾选行）
```

规则：

- 列表分组头与区块头视觉一致（同样的字号、内边距、hairline、`▶`）；区别只是有没有计数与动作。
- 卡片不嵌卡片；折叠块最多嵌一层（消息 → 分段允许）。
- 顶层区块下的子区块用 `.ptSubBlocks`（左侧竖线 + 降一级的 `.ptSubTitle`）。
- 区块说明只允许两种形式：一句 `.ptHint` / `.ptSectionNote`，或 `title` 悬停；不并列两句。
- 悬停说明的文案与机制不变；可悬停的文字统一 `cursor:help`。

---

## 3. 按钮

| 类 | 用途 | 规格 |
|---|---|---|
| `.ptBtn` | 常规动作 | 28px、8px 圆角、hairline |
| `.ptBtn[data-tone=primary]` | 区块主动作 | 28px、全 pill、accent 实底 |
| `.ptBtn[data-tone=danger]` | 破坏性动作 | 28px、描边 + error 色；**实底只出现在确认弹窗** |
| `.ptBtnLarge` | 页面主动作 | 36px、pill；只有 `data-tone=primary` 才是实底 |
| `.ptTextBtn` | 静默动作 | 12px、无边框 |
| `.ptChip` / `.ptSegBtn` | 筛选型切换 | 24px / 24px 分段 |

规则：

- 同一屏幕只允许一个 accent 实底主按钮。定制页的「预览定制结果」是次级大按钮，
  「应用并发送」才是唯一主按钮。
- 破坏性动作排在最后，与主按钮之间留间距并隔一条 `.ptDivider`，不与主按钮同行。
- 工具条批量动作顺序固定：**折叠全部 → 展开全部**。
- 所有按钮 `:focus-visible` 用 `--pt-focus` 内描边，`:active` 统一 `scale(.97)`。

---

## 4. 标签与读数

- 左簇 `.ptTag` 只表达状态/关系：来源层、失败、已禁用、禁用条件、缺服务、被覆盖、
  subagent / 分叉 / 父会话、提示词定制状态、本模式替换/追加、置信度、影响条件、归属插件、
  lazy、有指导、未归属。4 档颜色：中性 / 强调（`data-tone="user"`）/ 警告 / 错误。
- 右簇 `.ptEnd`（`shared.rowEnd(...)`）只放读数：`order N`、`54B`、`工具 12`、`调用 48`、
  `#3`、`3/12`、相对时间。**数字不再用胶囊**。
- 行内顺序固定：`[缩进][状态点][名称 + 副标题][左簇标签…][.ptEnd 读数…]`。
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

---

## 6. 逐页落点

| 文件 | 责任 |
|---|---|
| `client.styles.js` | token 三层 + 全部组件规则；新增类先在这里定义 |
| `client.shared.js` | `useThemePreference / normalizeTheme / THEMES / rowEnd / resultText` |
| `client.page.js` | 外观三段控件、`data-pt-theme`、页面壳 |
| `client.plugins.js` | 行标签/读数分区、详情顺序与 divider、详情收起 |
| `client.sessions.js` | 行标签/读数分区、分组头右簇 |
| `client.session-detail.js` | 详情收起、绑定区的读/写分隔、子块标题 |
| `client.tools.js` | 两段区块折叠头、来源分组头、工具行读数 |
| `client.preview.js` | 条件/规模两行、内容区块头、折叠行右簇 |
| `client.disable-preview.js` | 插件禁用预演：被禁用的插件、连锁反应（失去项 + 下游插件）、依赖关系图、配置与覆盖、证据与边界 |
| `client.impact-tree.js` | 上下游关系树：完整影响链路（host 闭包）+ 上游提供者；去重、环检测、固定几何布局；纯函数，不碰 React；视图用图专用 token 画节点与连线 |
| `client.preview-messages.js` / `client.influence.js` / `client.preview-raw.js` | 右簇、区块头、窗口规则 |
| `client.editor.js` / `client.editor-messages.js` / `client.template-card.js` | 区块头、按钮层级、卡片语法 |

窗口规则：整份请求正文（system / tools / messages）用 `.ptWindow`（320px，内部滚动）；
单段原文不限高（随折叠展开全文），避免两层滚动条。

破坏性清理在定制页底部默认收起成一行居中小字（`details.ptCleanupFold` + CSS 三角），
展开才是清理卡片，再点一次收起；危险操作不常驻版面。定制页的「预览定制结果」进入独立视图，
用 `.ptPageTitle` 标明「提示词定制结果预览」，不再用一句小字解释它是只读预览。

---

## 7. 维护检查

```powershell
npm run verify          # 23 项；含 verify:theme
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
