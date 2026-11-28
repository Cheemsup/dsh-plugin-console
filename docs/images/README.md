# README 截图清单

README.md / README_en.md 里的插图都放在本目录，并按 `编号-页面.png` 命名。
两份 README 引用图片时使用 `raw.githubusercontent.com` 的绝对地址，**不要改成相对路径**：
npm 等页面解析不到仓库内的相对图片。

| 编号 | 文件 | 内容 |
|---|---|---|
| 1 | `01-plugins.png` | 插件页：插件列表、状态与展开后的能力贡献 |
| 2 | `02-sessions.png` | 会话页：会话涉及的插件与首次请求上下文 |
| 3 | `03-preview.png` | 上下文预演页：条件、规模与内容标签 |
| 4 | `04-disable-preview.png` | 插件禁用预演页：连锁反应与依赖关系图 |
| 5 | `05-surface-tools.png` | 插件能力面 · 工具段：统一插件选择器、按插件来源的工具集、模式预设工具集 |
| 6 | `06-surface-network.png` | 插件能力面 · 网络段：受控出口 → 直连出口 → 入站入口 |

提示词定制页目前只有文字说明，没有配图；若以后补图，新增 `07-editor.png`
并同时更新 README、README_en 与 `screenshots.json`。

补图时保持当前编号不变，避免 README 里的绝对地址失效；旧图直接用新文件覆盖即可。
截图使用面板默认的「跟随 DSH」外观，避免把含凭据的配置值或私人路径拍进图里。
