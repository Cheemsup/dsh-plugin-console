# dsh-plugin-console

[简体中文](README.md) · [English](README_en.md)

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://opensource.org/license/mit)

DeepSeek Harness（DSH）的侧边栏插件控制台：通过运行时对象分析以及原始文件扫描处理的方式获取关于插件、会话、工具等信息并通过页面向用户展示；同时提供模型上下文预演、插件禁用影响与配置覆盖关系的预演，以及相应的上下文定制功能

## 功能

- **插件** — 浏览这台机器装了哪些插件，查看启用状态、组合链、服务依赖、登记的行为、贡献的工具与提示词段等，帮助掌控DSH内的插件行为和关系
- **会话** — 追踪「全局插件 → 模式要求的插件 → 本会话」的来源链，可读首次请求的系统提示词、工具 schema 与消息注入等内容
- **工具** — 可按注册的插件分组查看工具，也可以看每个模式的预设工具集，帮助观察DSH中每个工具的来源以及详细信息
- **上下文预演** — 指定模式、工作区与权限预设，查看新会话第一条消息发出前模型会收到的完整上下文构造
- **插件禁用预演** — 选择任一插件，预演禁用它会失去哪些工具、提示词段与运行时注入；按「所需服务的提供者全部不可用」沿依赖链推导到不动点，列出所有会依次不可用的插件与完整因果路径。同时按组合层（bundle / profile / home / 启动覆盖）展示 config 声明与生效值的差异，以及上下游插件的依赖树。页面只读，不执行禁用。
- **提示词定制模板** — 通过插件自管理规则文件的方式支撑起基于DSH标准模型上下文的定制改造；同时配套了对于模板的开关、继承、清理等完整生命周期控制手段

## 安装

```sh
# 从 npm 安装
dsh plugin --profile <profile> add @cheemsup/dsh-plugin-console

# 从 GitHub 安装
dsh plugin --profile <profile> add github:Cheemsup/dsh-plugin-console

# 从本地目录安装（开发）
dsh plugin --profile <profile> add file:<本目录绝对路径>
```

## 界面

### 插件页

![插件页](https://raw.githubusercontent.com/Cheemsup/dsh-plugin-console/main/docs/images/01-plugins.png)

*图 1 · 插件页：说明了DSH内插件的信息、行为、依赖关系等信息*

### 会话页

![会话页](https://raw.githubusercontent.com/Cheemsup/dsh-plugin-console/main/docs/images/02-sessions.png)

*图 2 · 会话页：展示了一个会话涉及的插件以及完整的首次请求上下文信息*

### 工具页

![工具页](https://raw.githubusercontent.com/Cheemsup/dsh-plugin-console/main/docs/images/03-tools.png)

*图 3 · 工具页：回答「模型能看到哪些工具、谁给的」。来源来自扫描插件包源码，提供友好阅读方式*

### 上下文预演

![上下文预演](https://raw.githubusercontent.com/Cheemsup/dsh-plugin-console/main/docs/images/04-preview.png)

*图 4 · 上下文预演页：回答「如果现在开一个新会话，第一条消息发出前模型会收到什么」，通过指定不同的工作区以及模式会带来不同的预演结果*

### 提示词定制模板

![定制编辑器](https://raw.githubusercontent.com/Cheemsup/dsh-plugin-console/main/docs/images/05-editor.png)

*图 5 · 定制编辑器：选定工作区以及模式，则能够在此预演基础上进行提示词的定制以及开启会话*

### 插件禁用预演

回答「如果禁用这个插件，会发生什么、会影响谁」。正文先给两块内容：**被禁用的插件**与**连锁反应**；
后者只回答两件事——会失去哪些工具与提示词（含下游插件连带贡献），以及哪些下游插件会受到影响。
影响面是派生计算：失去表示没有其他所有者；
依赖链按「所需服务的提供者全部不可用」迭代到不动点，列出每一层不可用的插件、缺少的服务与从目标
出发的完整因果路径。依赖图与配置分层收在后面的独立区块里；配置分层展示 patch 文件里的声明与
Loader 的生效值，读不到的层会标注原因，消息注入归属与分组子行标为推断。页面只读，执行禁用仍在
插件详情的控制区。

## 数据可信度

- **运行时事实**：插件条目与状态、工具与提示词注册、会话日志，直接读宿主。
- **推导**：工作区、权限、指令文件、skill 目录与时间快照，用同一份配置和文件重算。
- **源码归属**：注册表不记录工具与提示词段是谁注册的，因此扫描插件包源码补齐。
- **文件事实**：bundle / profile / home 的 patch 文件与其中的 config 子树；文件读不到或写法不受支持时标注原因。
- **未知 / 不可用**：缺少输入或宿主没有暴露这项能力时如实标注，推导不会被写成实测。

## 已知边界

- 需要宿主提供 `connection` 服务，否则只加载插件、不注册路由。
- 冷会话没有 fiber：只显示记录与模式要求的插件，无法判断本进程实际挂载了什么。
- 上下文预演是预测，不是记录；附件 / 图片、后续轮次与 goal / plan / schedule 等动态注入不在
  范围内，子 Agent 的首请求也不纳入。
- 活动只统计工具型贡献，默认最近 7 天、最多 20 个会话（实验性功能）；只提供服务或只监听事件的插件没有调用数。
- 插件禁用预演是派生计算，不执行禁用、也不模拟运行时卸载；「失去」只表示没有其他所有者。依赖链按 inject 声明推导到不动点，语义是禁用并重载/重启后，已激活的插件可能在下一次重载前仍保留注册与工具。配置分层只展示 patch 文件声明与生效值，patch 的合并语义未公开，诊断不推断原因；内置组合包或缺少 `pluginPackages` 时 bundle patch 不可读，会如实标注。
- 提示词定制**只影响模型上下文，不改变实际权限**，工具禁用除外。
- 清理模板数据只删持久记录，运行中的会话会一直保留已注册内容，直到结束或 DSH 重启。

## 开发

架构与修改约束见 [CLAUDE.md](CLAUDE.md)，界面规范见
[docs/design-ui.md](docs/design-ui.md)，可能的下一步方向见 [docs/next-direction.md](docs/next-direction.md)。

## 许可

MIT
