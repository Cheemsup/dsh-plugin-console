/**
 * 整份样式表与一次性注入。
 *
 * 样式只在首次 materialize 时注入一次：重复 materialize 不该重复插入 `<style>`。
 *
 * 颜色分三层：
 *   1. `.ptRoot` 里的「跟随 DSH」映射——把宿主 `--dsw-alias-*` 接到 `--pt-*`；
 *   2. `[data-pt-theme=light]` / `[data-pt-theme=dark]` 两套固定色板；
 *   3. 组件规则只允许引用 `--pt-*`。
 * 这条边界由 `scripts/verify-theme.mjs` 强制：组件里再写一个 `--dsw-alias-*`，
 * 显式主题就会花掉，而且没人会在跟随模式下发现。
 *
 * 外观选择是浏览器本地偏好（`localStorage`），只作用于本面板，不改宿主主题。
 *
 * 本文件是一个包内 chunk：入口用 `require.async('./client.styles.js')` 取它，
 * 工厂返回 `{ CSS, ensureStyles }`。
 */

window.__ModuleLoader__.load({
  id: '@cheemsup/dsh-plugin-console',
  chunk: 'client.styles.js',
  factory: () => {
    /** 样式标签的稳定 id；同一个 id 只允许一个标签存在。 */
    const TAG_ID = 'dsh-plugin-console/plugin-console.css'

    /** 面板的全部样式。 */ const CSS = `
/* ── Token：跟随 DSH（默认）────────────────────────────────────────────
   显式主题块会整体覆盖这组值；组件规则只认 --pt-*。
   圆角与阴影不随主题变，所以留在这一块。 */
.ptRoot{
  --pt-canvas:transparent;
  --pt-surface-1:var(--dsw-alias-bg-layer-2,#f5f5f7);
  --pt-surface-2:var(--dsw-alias-bg-layer-1,#ffffff);
  --pt-surface-3:var(--dsw-alias-bg-layer-3,#f0f0f2);
  --pt-line-1:var(--dsw-alias-border-l3,#e0e0e3);
  --pt-line-2:var(--dsw-alias-border-l2,#ececef);
  --pt-line-3:var(--dsw-alias-border-l4,#d2d2d7);
  --pt-text-1:var(--dsw-alias-label-primary,#1d1d1f);
  --pt-text-2:var(--dsw-alias-label-secondary,#6e6e73);
  --pt-text-3:var(--dsw-alias-label-tertiary,#86868b);
  --pt-accent:var(--dsw-alias-state-business-primary,#0066cc);
  --pt-accent-hover:var(--dsw-alias-state-business-primary,#0071e3);
  --pt-accent-soft:var(--dsw-alias-state-business-tertiary,var(--dsw-alias-bg-layer-3,#eaf2fd));
  --pt-on-accent:#ffffff;
  --pt-warn:var(--dsw-alias-state-warn-primary,#a86b12);
  --pt-warn-soft:var(--dsw-alias-state-warn-tertiary,var(--dsw-alias-bg-layer-3,#fbf3e4));
  --pt-error:var(--dsw-alias-state-error-primary,#d93b40);
  --pt-error-soft:var(--dsw-alias-state-error-tertiary,var(--dsw-alias-bg-layer-3,#fbeceb));
  --pt-error-line:rgba(217,59,64,.45);
  --pt-warn-line:rgba(168,107,18,.45);
  --pt-success:var(--dsw-alias-state-success-primary,#0f9184);
  --pt-hover:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.045));
  --pt-focus:var(--dsw-alias-state-business-primary,#0071e3);
  --pt-code-bg:var(--dsw-alias-bg-module-platform,var(--dsw-alias-bg-layer-1,#f5f5f7));
  --pt-skeleton:var(--dsw-alias-bg-skeleton,var(--dsw-alias-bg-layer-2,#f0f0f2));
  --pt-scrim:rgba(0,0,0,.38);
  --pt-on-solid:#ffffff;
  --pt-knob:#ffffff;
  --pt-dock-shadow:0 6px 14px -10px rgba(0,0,0,.45);
  --pt-knob-shadow:0 0 0 .5px rgba(0,0,0,.18);
  --pt-shadow:0 12px 32px rgba(0,0,0,.24);
  --pt-hit-0-bg:rgba(217,59,64,.28);--pt-hit-0-solid:#d93b40;
  --pt-hit-1-bg:rgba(183,121,31,.3);--pt-hit-1-solid:#a86b12;
  --pt-hit-2-bg:rgba(15,148,136,.26);--pt-hit-2-solid:#0f9184;
  --pt-hit-3-bg:rgba(63,111,216,.26);--pt-hit-3-solid:#3f6fd8;
  --pt-hit-4-bg:rgba(124,92,214,.26);--pt-hit-4-solid:#7c5cd6;
  --pt-hit-5-bg:rgba(192,38,143,.26);--pt-hit-5-solid:#c0268f;
  --pt-graph-node-fill:var(--dsw-alias-bg-layer-2,#f5f5f7);
  --pt-graph-node-line:var(--dsw-alias-border-l4,#b9b9bf);
  --pt-graph-edge:var(--dsw-alias-label-tertiary,#7c7c82);
  --pt-graph-label-bg:var(--dsw-alias-bg-layer-1,#ffffff);
  --pt-r-xs:4px;--pt-r-sm:6px;--pt-r-md:8px;--pt-r-lg:12px;--pt-r-pill:999px;
  box-sizing:border-box;height:100%;display:flex;flex-direction:column;
  color:var(--pt-text-1);background:var(--pt-canvas);
  font-size:13px;line-height:1.5;
}
/* ── Token：明亮（Apple 中性）────────────────────────────────────────── */
.ptRoot[data-pt-theme=light]{
  --pt-canvas:#ffffff;
  --pt-surface-1:#f5f5f7;
  --pt-surface-2:#ffffff;
  --pt-surface-3:#f0f0f2;
  --pt-line-1:#e0e0e3;
  --pt-line-2:#ececef;
  --pt-line-3:#d2d2d7;
  --pt-text-1:#1d1d1f;
  --pt-text-2:#6e6e73;
  --pt-text-3:#86868b;
  --pt-accent:#0066cc;
  --pt-accent-hover:#0071e3;
  --pt-accent-soft:rgba(0,102,204,.1);
  --pt-on-accent:#ffffff;
  --pt-warn:#a86b12;
  --pt-warn-soft:rgba(168,107,18,.12);
  --pt-error:#d93b40;
  --pt-error-soft:rgba(217,59,64,.1);
  --pt-error-line:rgba(217,59,64,.45);
  --pt-warn-line:rgba(168,107,18,.45);
  --pt-success:#0f9184;
  --pt-hover:rgba(0,0,0,.045);
  --pt-focus:#0071e3;
  --pt-code-bg:#f5f5f7;
  --pt-skeleton:#f0f0f2;
  --pt-scrim:rgba(0,0,0,.3);
  --pt-on-solid:#ffffff;
  --pt-knob:#ffffff;
  --pt-dock-shadow:0 6px 14px -10px rgba(0,0,0,.28);
  --pt-knob-shadow:0 0 0 .5px rgba(0,0,0,.16);
  --pt-shadow:0 12px 32px rgba(0,0,0,.16);
  --pt-hit-0-bg:rgba(217,59,64,.22);--pt-hit-0-solid:#d93b40;
  --pt-hit-1-bg:rgba(168,107,18,.24);--pt-hit-1-solid:#a86b12;
  --pt-hit-2-bg:rgba(15,145,132,.22);--pt-hit-2-solid:#0f9184;
  --pt-hit-3-bg:rgba(63,111,216,.2);--pt-hit-3-solid:#3f6fd8;
  --pt-hit-4-bg:rgba(124,92,214,.2);--pt-hit-4-solid:#7c5cd6;
  --pt-hit-5-bg:rgba(192,38,143,.2);--pt-hit-5-solid:#c0268f;
  --pt-graph-node-fill:#f5f5f7;
  --pt-graph-node-line:#b9b9bf;
  --pt-graph-edge:#7c7c82;
  --pt-graph-label-bg:#ffffff;
  color-scheme:light;
}
/* ── Token：夜间（Apple 近黑）────────────────────────────────────────── */
.ptRoot[data-pt-theme=dark]{
  --pt-canvas:#1d1d1f;
  --pt-surface-1:#272729;
  --pt-surface-2:#2a2a2c;
  --pt-surface-3:#333336;
  --pt-line-1:#3a3a3c;
  --pt-line-2:#2f2f31;
  --pt-line-3:#48484a;
  --pt-text-1:#f5f5f7;
  --pt-text-2:#a1a1a6;
  --pt-text-3:#86868b;
  --pt-accent:#2997ff;
  --pt-accent-hover:#4aa9ff;
  --pt-accent-soft:rgba(41,151,255,.16);
  --pt-on-accent:#0b0b0c;
  --pt-warn:#e8a33d;
  --pt-warn-soft:rgba(232,163,61,.16);
  --pt-error:#f56b6b;
  --pt-error-soft:rgba(245,107,107,.14);
  --pt-error-line:rgba(245,107,107,.42);
  --pt-warn-line:rgba(232,163,61,.42);
  --pt-success:#30d158;
  --pt-hover:rgba(255,255,255,.06);
  --pt-focus:#4aa9ff;
  --pt-code-bg:#202022;
  --pt-skeleton:#2a2a2c;
  --pt-scrim:rgba(0,0,0,.55);
  --pt-on-solid:#0b0b0c;
  --pt-knob:#f5f5f7;
  --pt-dock-shadow:0 6px 14px -10px rgba(0,0,0,.7);
  --pt-knob-shadow:0 0 0 .5px rgba(0,0,0,.4);
  --pt-shadow:0 16px 40px rgba(0,0,0,.5);
  --pt-hit-0-bg:rgba(255,123,123,.26);--pt-hit-0-solid:#ff7b7b;
  --pt-hit-1-bg:rgba(232,179,57,.26);--pt-hit-1-solid:#e8b339;
  --pt-hit-2-bg:rgba(63,214,198,.24);--pt-hit-2-solid:#3fd6c6;
  --pt-hit-3-bg:rgba(122,167,255,.24);--pt-hit-3-solid:#7aa7ff;
  --pt-hit-4-bg:rgba(184,155,255,.24);--pt-hit-4-solid:#b89bff;
  --pt-hit-5-bg:rgba(255,122,200,.24);--pt-hit-5-solid:#ff7ac8;
  --pt-graph-node-fill:#2f2f31;
  --pt-graph-node-line:#5f5f64;
  --pt-graph-edge:#a1a1a6;
  --pt-graph-label-bg:#1d1d1f;
  color-scheme:dark;
}
/* 布局：顶栏（标题 + 标签 + 工具条）固定，只有正文滚动。 */
.ptBar{padding:20px 28px 0;display:flex;flex-direction:column;gap:12px;flex:none}
.ptHead{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.ptTitle{margin:0;font-size:18px;font-weight:600;line-height:26px;letter-spacing:-.01em}
/* 页面内的独立视图标题（如「提示词定制结果预览」）：与页头标题同一档，但不占页头。 */
.ptPageTitle{margin:2px 0 10px;font-size:18px;font-weight:600;line-height:26px;letter-spacing:-.01em;color:var(--pt-text-1)}
.ptSub{color:var(--pt-text-3);font-size:12px;line-height:18px}
.ptSpacer{flex:1}
/* 按钮：次级默认、primary 实底 pill、danger 描边；全站只有这一套。 */
.ptBtn{box-sizing:border-box;border:.5px solid var(--pt-line-3);border-radius:var(--pt-r-md);background:var(--pt-surface-1);color:var(--pt-text-1);height:28px;padding:0 12px;font:inherit;font-size:12px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:6px;white-space:nowrap;transition:background .12s ease,border-color .12s ease}
.ptBtn:hover:not(:disabled){background:var(--pt-hover)}
.ptBtn:active:not(:disabled){transform:scale(.97)}
.ptBtn:disabled{opacity:.45;cursor:default}
.ptBtn:focus-visible{outline:2px solid var(--pt-focus);outline-offset:1px}
.ptBtn[data-tone=primary]{border-color:transparent;border-radius:var(--pt-r-pill);background:var(--pt-accent);color:var(--pt-on-accent)}
.ptBtn[data-tone=primary]:hover:not(:disabled){background:var(--pt-accent-hover)}
.ptBtn[data-tone=danger]{border-color:var(--pt-line-3);color:var(--pt-error);background:transparent}
.ptBtn[data-tone=danger]:hover:not(:disabled){background:var(--pt-error-soft)}
/* 最终确认弹窗里的危险按钮才实底：其余危险动作保持描边，避免整页到处是红。 */
.ptModalActions .ptBtn[data-tone=danger]{background:var(--pt-error);border-color:transparent;color:var(--pt-on-solid)}
.ptBtnLarge{box-sizing:border-box;height:36px;padding:0 24px;font-size:13px;border-radius:var(--pt-r-pill)}
.ptBtnLarge[data-tone=primary]{background:var(--pt-accent);border-color:transparent;color:var(--pt-on-accent)}
.ptBtnLarge[data-tone=primary]:hover:not(:disabled){background:var(--pt-accent-hover)}
.ptMeta{display:inline-flex;align-items:center;gap:5px;color:var(--pt-text-3);font-size:11.5px;line-height:18px;white-space:nowrap}
.ptMetaWrap{white-space:normal;flex-wrap:wrap;row-gap:2px}
.ptMetaSep{opacity:.55}
.ptMetaStrong{color:var(--pt-text-1);font-weight:600}
.ptDirty{display:inline-flex;align-items:center;gap:5px;color:var(--pt-warn);font-size:11.5px;white-space:nowrap}
.ptDirty::before{content:'';width:5px;height:5px;border-radius:50%;background:currentColor}
/* 主标签：分段控件，当前项浮在底槽上而不是反色块。 */
.ptTabs{display:inline-flex;align-items:center;gap:1px;padding:2px;border-radius:var(--pt-r-md);background:var(--pt-surface-1);align-self:flex-start}
.ptTabsSmall{background:transparent;padding:0;gap:4px;margin-bottom:12px}
.ptTab{display:inline-flex;align-items:center;gap:5px;border:0;border-radius:var(--pt-r-sm);background:transparent;color:var(--pt-text-2);height:26px;padding:0 11px;font:inherit;font-size:12px;cursor:pointer;white-space:nowrap}
.ptTab:hover{color:var(--pt-text-1)}
.ptTab[aria-selected=true]{background:var(--pt-surface-2);color:var(--pt-text-1);box-shadow:0 0 0 .5px var(--pt-line-1)}
.ptTab:focus-visible{outline:2px solid var(--pt-focus);outline-offset:-2px}
.ptTabCount{font-size:10.5px;font-weight:400;color:var(--pt-text-3);font-variant-numeric:tabular-nums}
.ptTab[aria-selected=true] .ptTabCount{color:var(--pt-text-2)}
.ptTabsSmall .ptTab{height:24px;padding:0 9px;font-size:11.5px;color:var(--pt-text-3)}
.ptTabsSmall .ptTab[aria-selected=true]{box-shadow:none;background:var(--pt-surface-1);color:var(--pt-text-1)}
/* 外观三段控件：与标签同一套浮起逻辑，只占一行里的一个控件宽度。 */
.ptSeg{display:inline-flex;align-items:center;gap:1px;padding:2px;border-radius:var(--pt-r-md);background:var(--pt-surface-1)}
.ptSegBtn{border:0;border-radius:var(--pt-r-sm);background:transparent;color:var(--pt-text-3);height:24px;padding:0 9px;font:inherit;font-size:11.5px;cursor:pointer;white-space:nowrap}
.ptSegBtn:hover{color:var(--pt-text-1)}
.ptSegBtn[aria-pressed=true]{background:var(--pt-surface-2);color:var(--pt-text-1);box-shadow:0 0 0 .5px var(--pt-line-1)}
.ptSegBtn:focus-visible{outline:2px solid var(--pt-focus);outline-offset:-2px}
/* 工具条：一个视图一行。搜索只出现在用得到它的视图里。 */
.ptToolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:0 0 8px;min-height:34px}
/* 页头搜索：所有视图共用同一入口，固定在标题下方、标签上方。 */
.ptSearchRow{display:flex;align-items:center}
/* 请求结构标签下的交棒提示：说明这一页的页头不筛列表，回车把词交给下面的检索。 */
.ptSearchHandoff{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.ptSearch.ptSearchTop{flex:1 1 auto;max-width:none;width:100%}
.ptSearch{box-sizing:border-box;flex:1 1 200px;min-width:140px;max-width:360px;height:28px;border:.5px solid var(--pt-line-3);border-radius:var(--pt-r-md);background:var(--pt-surface-1);color:var(--pt-text-1);font:inherit;font-size:12.5px;padding:0 10px;outline:none}
.ptSearch::placeholder{color:var(--pt-text-3)}
.ptSearch:focus{border-color:var(--pt-accent)}
/* 页内多词标记：工具行与命中高亮。与页头筛选搜索不同，这里不隐藏任何内容。 */
.ptSearchTools{display:flex;flex-direction:column;gap:6px;margin:0 0 10px;padding:8px 10px;border:.5px solid var(--pt-line-2);border-radius:var(--pt-r-md);background:var(--pt-surface-1)}
/* 有搜索框时吸顶：长文本下滑后，改词与上/下定位仍然在手边；它只在所属区块内生效。 */
.ptSearchTools[data-docked=true]{position:sticky;top:0;z-index:6;box-shadow:var(--pt-dock-shadow)}
.ptSearchToolsHead{display:flex;align-items:center;gap:8px}
.ptSearchToolsTitle{font-size:11.5px;font-weight:600;color:var(--pt-text-2);flex:1}
.ptSearchList{display:flex;flex-direction:column;gap:5px}
.ptSearchItem{display:flex;align-items:center;gap:6px;min-width:0}
.ptSearchSwatch{flex:none;display:inline-flex;align-items:center;justify-content:center;min-width:18px;height:18px;box-sizing:border-box;padding:0 4px;border-radius:var(--pt-r-xs);background:var(--pt-hit-solid);color:var(--pt-on-solid);font-size:10px;font-weight:600;font-variant-numeric:tabular-nums}
.ptSearch.ptSearchInline{flex:1 1 auto;max-width:none;height:26px}
.ptSearchCount{flex:none;color:var(--pt-text-3);font-size:11px;font-variant-numeric:tabular-nums;white-space:nowrap}
/* 上/下定位：与 PDF 查看器一致，计数夹在两个箭头之间。 */
.ptSearchNav{flex:none;display:inline-flex;align-items:center;gap:2px}
.ptSearchNavBtn{width:20px;height:20px;box-sizing:border-box;padding:0;border:.5px solid var(--pt-line-2);border-radius:var(--pt-r-xs);background:var(--pt-surface-2);font-size:11px;line-height:17px;color:var(--pt-text-2)}
.ptSearchNavBtn:hover:not(:disabled){color:var(--pt-text-1);background:var(--pt-hover)}
.ptSearchNavBtn:disabled{opacity:.4;cursor:default}
/* 当前定位到的那一处加内描边，不改变行高。 */
.ptSearchMark[data-current=true]{box-shadow:inset 0 0 0 1.5px var(--pt-hit-solid)}
/* 命中底色用低透明度，明暗主题下正文颜色都不变；徽标由 ::after 画出，不插节点、不进复制文本。 */
.ptSearchMark{position:relative;border-radius:2px;padding:0;background:var(--pt-hit-bg);color:inherit}
.ptSearchMark::after{content:attr(data-box);position:absolute;top:-7px;right:-4px;min-width:13px;height:12px;box-sizing:border-box;padding:0 3px;border-radius:6px;background:var(--pt-hit-solid);color:var(--pt-on-solid);font:600 8.5px/12px var(--ds-font-family-code,ui-monospace,monospace);text-align:center;pointer-events:none;user-select:none}
/* 每个搜索框一种颜色，编号与色板同源；主题切换时整套一起换。 */
.ptSearchMark[data-search="0"],.ptSearchSwatch[data-search="0"]{--pt-hit-bg:var(--pt-hit-0-bg);--pt-hit-solid:var(--pt-hit-0-solid)}
.ptSearchMark[data-search="1"],.ptSearchSwatch[data-search="1"]{--pt-hit-bg:var(--pt-hit-1-bg);--pt-hit-solid:var(--pt-hit-1-solid)}
.ptSearchMark[data-search="2"],.ptSearchSwatch[data-search="2"]{--pt-hit-bg:var(--pt-hit-2-bg);--pt-hit-solid:var(--pt-hit-2-solid)}
.ptSearchMark[data-search="3"],.ptSearchSwatch[data-search="3"]{--pt-hit-bg:var(--pt-hit-3-bg);--pt-hit-solid:var(--pt-hit-3-solid)}
.ptSearchMark[data-search="4"],.ptSearchSwatch[data-search="4"]{--pt-hit-bg:var(--pt-hit-4-bg);--pt-hit-solid:var(--pt-hit-4-solid)}
.ptSearchMark[data-search="5"],.ptSearchSwatch[data-search="5"]{--pt-hit-bg:var(--pt-hit-5-bg);--pt-hit-solid:var(--pt-hit-5-solid)}
/* 页头筛选的命中标记：单色、无编号、不改变行高。它与页内检索的彩色徽标是两种东西——
   前者回答「这一行为什么留下」，后者回答「第几个搜索框的第几处」。 */
.ptQueryMark{border-radius:2px;padding:0;background:var(--pt-warn-soft);color:inherit;box-shadow:inset 0 -1px 0 var(--pt-warn)}
/* 行内「为什么留下」的摘要：只占一行，机制说明挂在 title 上。 */
.ptQueryReason{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--pt-text-2);font-size:11px;line-height:15px}
.ptField{display:inline-flex;align-items:center;gap:6px;min-width:0}
.ptFieldLabel{color:var(--pt-text-3);font-size:11px;white-space:nowrap}
.ptSelect{box-sizing:border-box;height:26px;max-width:220px;border:.5px solid var(--pt-line-3);border-radius:var(--pt-r-md);background-color:var(--pt-surface-1);color:var(--pt-text-1);font:inherit;font-size:12px;padding:0 22px 0 8px;outline:none;cursor:pointer;appearance:none;background-image:linear-gradient(45deg,transparent 50%,var(--pt-text-3) 50%),linear-gradient(135deg,var(--pt-text-3) 50%,transparent 50%);background-position:calc(100% - 13px) 11px,calc(100% - 9px) 11px;background-size:4px 4px,4px 4px;background-repeat:no-repeat}
.ptSelect:focus{border-color:var(--pt-accent)}
.ptSelect:disabled{opacity:.45;cursor:default}
.ptResult{color:var(--pt-text-3);font-size:11px;white-space:nowrap;font-variant-numeric:tabular-nums}
.ptResult b{font-weight:600;color:var(--pt-text-2)}
.ptActions{display:inline-flex;align-items:center;gap:4px;margin-left:auto}
.ptTextBtn{border:0;background:transparent;color:var(--pt-text-3);font:inherit;font-size:11.5px;padding:2px 5px;border-radius:var(--pt-r-xs);cursor:pointer;white-space:nowrap}
.ptTextBtn:hover:not(:disabled){color:var(--pt-text-1);background:var(--pt-hover)}
.ptTextBtn:disabled{opacity:.45;cursor:default}
.ptTextBtn[data-tone=danger]{color:var(--pt-error)}
.ptTextBtn:focus-visible{outline:2px solid var(--pt-focus);outline-offset:1px}
/* 右簇：一行里所有读数（长度、order、次数、时间）统一靠右，不再用胶囊包数字。 */
.ptEnd{display:inline-flex;align-items:center;gap:6px;margin-left:auto;flex:none;min-width:0}
/* 正文 */
.ptBody{flex:1;min-height:0;overflow:auto;padding:4px 28px 48px}
.ptNotice{margin:24px 0;color:var(--pt-text-3);font-size:13px}
.ptError{color:var(--pt-error)}
.ptEmpty{padding:32px 8px;text-align:center;color:var(--pt-text-3);font-size:12.5px}
.ptSkeleton{height:30px;border-radius:var(--pt-r-md);background:var(--pt-skeleton);opacity:.55;margin-bottom:4px}
/* 分组头：列表分组（插件类别 / 会话工作区 / 工具来源）共用一套外观。 */
.ptGroupHead,.ptOwnerHead{padding:10px 8px 6px;display:flex;flex-wrap:wrap;align-items:center;gap:4px 8px;font-size:12px;font-weight:600;border-bottom:.5px solid var(--pt-line-2);min-height:34px;box-sizing:border-box}
.ptGroupHead>span[title]{cursor:help}
.ptGroupHeadClickable{cursor:pointer;border-radius:var(--pt-r-sm);transition:background .12s ease}
.ptGroupHeadClickable:hover{background:var(--pt-hover)}
.ptGroupHeadClickable:focus-visible{outline:2px solid var(--pt-focus);outline-offset:-2px}
summary.ptOwnerHead{cursor:pointer;list-style:none}
summary.ptOwnerHead::-webkit-details-marker{display:none}
summary.ptOwnerHead:hover{background:var(--pt-hover)}
summary.ptOwnerHead:focus-visible{outline:2px solid var(--pt-focus);outline-offset:-2px}
.ptChevron{display:inline-block;width:10px;color:var(--pt-text-3);font-size:9px;transition:transform .12s ease}
.ptChevron[data-open=true],details[open]>summary .ptChevron{transform:rotate(90deg)}
.ptCount{flex:none;color:var(--pt-text-3);font-size:11px;font-variant-numeric:tabular-nums;font-weight:400}
/* 区块头：详情/编辑器里的章节。静态时是 div，可折叠时是 details>summary。 */
.ptSectionHead{display:flex;align-items:center;flex-wrap:wrap;gap:6px 8px;min-height:26px;padding:0 0 6px;border-bottom:.5px solid var(--pt-line-2);box-sizing:border-box}
summary.ptSectionHead{cursor:pointer;list-style:none;padding:6px 0}
summary.ptSectionHead::-webkit-details-marker{display:none}
summary.ptSectionHead:focus-visible{outline:2px solid var(--pt-focus);outline-offset:-2px}
.ptSectionHead .ptActions{margin-left:auto}
.ptSectionHead .ptCardTitle,.ptSectionHead .ptSectionTitle{margin:0}
/* 区块折叠：工具页两段、预演页的报告块共用；展开状态由 details 自己管。 */
.ptSectionFold{border:.5px solid var(--pt-line-2);border-radius:var(--pt-r-lg);background:var(--pt-surface-1);margin:0 0 14px;overflow:hidden}
.ptSectionFold>summary.ptSectionHead{padding:8px 12px}
.ptSectionBody{padding:10px 12px 12px}
/* 列表行 */
.ptList{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:0}
.ptRow{display:flex;align-items:center;gap:8px;flex-wrap:wrap;row-gap:2px;width:100%;min-height:34px;box-sizing:border-box;border:0;border-radius:var(--pt-r-md);background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer;padding:5px 8px}
.ptRow:hover{background:var(--pt-hover)}
.ptRow[data-selected=true]{background:var(--pt-hover)}
.ptRow[data-off=true] .ptName{color:var(--pt-text-2)}
.ptRow[data-failed=true] .ptName{color:var(--pt-error)}
.ptRow:focus-visible{outline:2px solid var(--pt-focus);outline-offset:-2px}
.ptIndent{flex:none}
.ptDot{flex:none;width:6px;height:6px;border-radius:50%;border:.5px solid var(--pt-line-3);box-sizing:border-box}
.ptDot[data-phase=active]{background:var(--pt-success);border-color:transparent}
.ptDot[data-phase=pending]{background:var(--pt-text-3);border-color:transparent}
.ptDot[data-phase=loading],.ptDot[data-phase=unloading]{background:var(--pt-warn);border-color:transparent}
.ptDot[data-phase=failed]{background:var(--pt-error);border-color:transparent}
.ptName{min-width:0;flex:0 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;line-height:19px}
.ptModule{color:var(--pt-text-3);font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:11px;line-height:15px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ptTag{flex:none;display:inline-flex;align-items:center;border-radius:var(--pt-r-xs);background:var(--pt-surface-3);color:var(--pt-text-2);padding:0 6px;font-size:10.5px;line-height:17px;font-family:var(--ds-font-family-code,ui-monospace,monospace);white-space:nowrap}
.ptTag[data-tone=user]{background:var(--pt-accent-soft);color:var(--pt-accent)}
.ptTag[data-tone=warn]{background:var(--pt-warn-soft);color:var(--pt-warn)}
.ptTag[data-tone=error]{background:var(--pt-error-soft);color:var(--pt-error)}
/* 详情：所有区块自上而下排列，同一行不再左右分栏。 */
.ptDetail{position:relative;background:var(--pt-surface-1);border:.5px solid var(--pt-line-2);border-radius:var(--pt-r-lg);margin:2px 0 12px 14px;padding:14px 16px 16px;display:flex;flex-direction:column;gap:16px}
.ptDetailClose{position:absolute;top:10px;right:10px}
.ptDetailGrid{display:flex;flex-direction:column;gap:16px;align-items:stretch}
.ptSection{display:flex;flex-direction:column;gap:6px;min-width:0}
.ptSectionTitle{font-size:12.5px;font-weight:600;color:var(--pt-text-1);margin:0}
/* 只读事实与写操作之间的分隔：动作永远在最后，且与上面的读数分开。 */
.ptDivider{border:0;border-top:.5px solid var(--pt-line-2);margin:2px 0;width:100%}
/* 顶层区块下的子区块：降一级标题 + 左侧竖线，避免与顶层区块读成同级。 */
.ptSubBlocks{display:flex;flex-direction:column;gap:12px;min-width:0;margin-top:2px;padding-left:10px;border-left:2px solid var(--pt-line-2)}
.ptSubSection{display:flex;flex-direction:column;gap:6px;min-width:0}
.ptSubTitle{margin:0;font-size:12px;font-weight:600;color:var(--pt-text-2)}
/* 标签、字段与元信息的解释都在 title 上；可悬停的读数统一给 help 光标与虚下划线。 */
.ptSectionTitle[title],.ptSub[title],.ptCardTitle[title],.ptSubTitle [title],.ptTag[title],.ptCount[title],.ptDepKey[title]{cursor:help}
.ptMeta span[title]{cursor:help;text-decoration:underline dotted;text-underline-offset:2px}
.ptSectionNote{margin:0;color:var(--pt-text-3);font-size:11.5px;line-height:17px}
.ptFacts{margin:0;display:grid;grid-template-columns:max-content minmax(0,1fr);gap:3px 12px;font-size:12px;line-height:19px}
.ptFacts dt{color:var(--pt-text-3)}
.ptFacts dt[title]{cursor:help;text-decoration:underline dotted;text-underline-offset:2px}
.ptFacts dd{margin:0;min-width:0;overflow-wrap:anywhere}
.ptFacts code{font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:11.5px;background:var(--pt-surface-3);border-radius:3px;padding:1px 5px}
/* 配置值：键与值成对排列，长值（JSON、凭据）自动折行。 */
.ptConfigList{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:3px;font-size:11.5px;line-height:18px}
.ptConfigList li{display:flex;flex-wrap:wrap;align-items:baseline;gap:5px;min-width:0}
.ptConfigEquals{color:var(--pt-text-3)}
.ptConfigValue{white-space:pre-wrap;overflow-wrap:anywhere}
.ptChain{display:flex;flex-wrap:wrap;align-items:center;gap:5px;font-size:11.5px}
.ptChainArrow{color:var(--pt-text-3);font-size:10px}
/* 加载/覆盖链：纵向步骤 + 连线，读起来就是一条链而不是一排标签。 */
.ptFlow{display:flex;flex-direction:column;gap:0;margin:2px 0 0}
.ptFlowStep{position:relative;display:flex;align-items:baseline;gap:8px;padding:3px 0 3px 18px;font-size:11.5px}
.ptFlowStep::before{content:'';position:absolute;left:5px;top:11px;width:5px;height:5px;border-radius:50%;background:var(--pt-accent)}
.ptFlowStep::after{content:'';position:absolute;left:7px;top:17px;bottom:-4px;width:1px;background:var(--pt-line-2)}
.ptFlowStep:last-child::after{display:none}
.ptFlowKey{flex:none;width:76px;white-space:nowrap;color:var(--pt-text-3);font-size:11px}
.ptFlowValue{min-width:0;overflow-wrap:anywhere;font-family:var(--ds-font-family-code,ui-monospace,monospace);color:var(--pt-text-2)}
.ptFlowStep[data-tone=muted]::before{background:var(--pt-text-3)}
.ptFlowStep[data-tone=muted] .ptFlowValue{color:var(--pt-text-3)}
.ptFlowStep[title]{cursor:help}
/* 插件禁用预演的上下游树：固定几何 + 线型区分边，深浅主题都只走 --pt-*。
   节点填色与边色单独成 token：线只有 1px 左右，借用表面色会在明亮主题下糊成一片。 */
.ptGraphWrap{overflow-x:auto;margin:6px 0 0}
.ptGraph{display:block;width:100%;min-width:520px;height:auto}
.ptGraphNode{cursor:pointer}
.ptGraphNode>rect{fill:var(--pt-graph-node-fill);stroke:var(--pt-graph-node-line);stroke-width:1;transition:stroke .12s ease}
.ptGraphNode:hover>rect{stroke:var(--pt-graph-edge)}
.ptGraphNode[data-tone=target]>rect{fill:var(--pt-accent-soft);stroke:var(--pt-accent);stroke-width:1.5}
.ptGraphNode[data-tone=pending]>rect{stroke:var(--pt-warn);stroke-width:1.5;stroke-dasharray:4 2}
.ptGraphNode[data-tone=pending]:hover>rect{stroke:var(--pt-warn)}
.ptGraphNode:focus-visible>rect{stroke:var(--pt-focus);stroke-width:2}
.ptGraphLabel{fill:var(--pt-text-1);font-size:12px;font-weight:600}
.ptGraphSub{fill:var(--pt-text-2);font-size:10.5px}
.ptGraphEdge{fill:none;stroke:var(--pt-graph-edge);stroke-width:1.25;stroke-linecap:round}
.ptGraphEdge[data-kind=config-reference]{stroke-dasharray:4 3}
.ptGraphEdge[data-kind=group-child]{stroke-dasharray:1.5 3}
.ptGraphArrow{fill:var(--pt-graph-edge)}
/* 边标签压在连线上：用画布色描一圈光晕，不用背景矩形容器。 */
.ptGraphEdgeLabel{fill:var(--pt-text-2);font-size:10.5px;paint-order:stroke fill;stroke:var(--pt-graph-label-bg);stroke-width:3;stroke-linejoin:round}
.ptDepList{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:2px;font-size:12px}
.ptDepList li{display:flex;gap:8px;align-items:baseline;overflow-wrap:anywhere}
.ptDepKey{font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:11.5px;color:var(--pt-text-2);flex:none}
.ptDepValue{color:var(--pt-text-3);min-width:0}
.ptMissing{color:var(--pt-error)}
/* 可折叠块：提示词段、工具、编辑器段落共用。 */
.ptFold{border:.5px solid var(--pt-line-2);border-radius:var(--pt-r-md);margin:2px 0;overflow:hidden;background:var(--pt-surface-2)}
.ptFold>summary{display:flex;align-items:center;gap:8px;padding:6px 10px;cursor:pointer;list-style:none;font-size:12.5px;line-height:20px}
.ptFold>summary::-webkit-details-marker{display:none}
.ptFold>summary:hover{background:var(--pt-hover)}
.ptFold>summary:focus-visible{outline:2px solid var(--pt-focus);outline-offset:-2px}
.ptFold>summary .ptFoldChevron{display:inline-block;width:10px;flex:none;color:var(--pt-text-3);font-size:9px;transition:transform .12s ease}
.ptFold[open]>summary .ptFoldChevron{transform:rotate(90deg)}
.ptFold[open]>summary{border-bottom:.5px solid var(--pt-line-2);background:var(--pt-surface-1)}
/* 整条目录被隐藏后，逐条设置不再生效：整块降级成只读，颜色随之下沉。 */
.ptFold[data-disabled=true]{opacity:.5}
.ptFold[data-disabled=true]>summary{cursor:default}
.ptFold[data-disabled=true]>summary .ptPromptName,
.ptFold[data-disabled=true]>summary .ptFoldMeta{color:var(--pt-text-3)}
.ptFoldMeta{margin-left:auto;color:var(--pt-text-3);font-size:11px;white-space:nowrap}
.ptPromptName{font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:12px;color:var(--pt-text-1);flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* 长文本必须自己滚动：max-height 配 overflow:visible 会把文字画到后面的兄弟节点上（系统提示词折叠曾是这种情况）。 */
.ptPromptText{margin:0;padding:10px 12px;font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:11.5px;line-height:18px;white-space:pre-wrap;overflow-wrap:anywhere;color:var(--pt-text-2);background:var(--pt-code-bg);max-height:none;overflow:auto}
/* 首次请求的三个部分统一用固定高度窗口：默认展开，超出窗口就滚动。 */
.ptWindow{max-height:320px;overflow:auto}
.ptToolBlock>summary{font-size:12px;padding:5px 10px}
/* 工具块是行里唯一的 flex 项：默认按内容宽度收，展开后 schema 右侧会留一段空档。让它占满整行。 */
.ptDepList li>.ptToolBlock{flex:1 1 auto;min-width:0}
/* 预演工具行：摘要即正文——占满宽度，名字一行、描述最多两行；展开才是完整说明。 */
.ptPreviewTool>summary{display:flex;flex-wrap:wrap;align-items:center;gap:4px 6px;padding:8px 12px;line-height:18px}
.ptPreviewToolName{font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:12.5px;font-weight:600;color:var(--pt-text-1);min-width:0;overflow-wrap:anywhere}
.ptPreviewToolDesc{flex:1 0 100%;min-width:0;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;white-space:normal;overflow-wrap:anywhere;font-size:12px;line-height:18px;color:var(--pt-text-2)}
/* 展开后正文里已有完整描述：摘要里的截断版收起，免得同一段话读两遍。 */
.ptPreviewTool[open]>summary .ptPreviewToolDesc{display:none}
.ptToolDesc{margin:8px 12px 0;font-size:12px;line-height:19px;color:var(--pt-text-2)}
.ptFold>summary .ptTextBtn{margin-left:2px}
.ptFoldBody{padding:10px 12px}
/* 参数视图：每个参数一块——头行放名字 / 类型 / 必填，说明与约束各占自己的行。 */
.ptSchema{margin-top:8px}
.ptSchemaHead{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
.ptSchemaSummary{color:var(--pt-text-3);font-size:11px}
.ptSchemaSpacer{flex:1}
.ptSchemaRows{margin:2px 0 0;padding:0;list-style:none;display:flex;flex-direction:column;gap:8px}
.ptSchemaItem{display:flex;flex-direction:column;gap:2px;min-width:0}
/* 一级参数之间用一条浅虚线分隔；子参数在缩进块里，层级已经说明了关系，不再画线。 */
.ptSchema>.ptSchemaRows>.ptSchemaItem:not(:last-child){padding-bottom:8px;border-bottom:.5px dashed var(--pt-line-2)}
/* 头行整体折行：名字按内容占宽，类型与必填紧跟其后；放不下时它们整体落到下一行。 */
.ptSchemaLine{display:flex;flex-wrap:wrap;align-items:baseline;gap:2px 8px;min-width:0}
.ptSchemaName{flex:0 1 auto;min-width:0;font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:12px;color:var(--pt-text-1);overflow-wrap:anywhere}
.ptSchemaType{flex:none;max-width:100%;font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:11px;color:var(--pt-text-3);overflow-wrap:anywhere}
.ptSchemaReq{flex:none;padding:0 5px;border:.5px solid var(--pt-accent);border-radius:3px;color:var(--pt-accent);font-size:10.5px;line-height:15px}
.ptSchemaMore{flex:none;color:var(--pt-text-3);font-size:10.5px}
/* 说明独占整行：它是最长的内容，和名字共用一行时两边都读不好。 */
.ptSchemaDesc{margin:0;color:var(--pt-text-2);font-size:12px;line-height:18px;white-space:pre-wrap;overflow-wrap:anywhere}
/* 约束用两列表：左列是标签，右列自行折行；枚举值在自己的网格里按最小宽度排列。 */
.ptSchemaFacts{margin:2px 0 0;display:grid;grid-template-columns:max-content minmax(0,1fr);gap:2px 10px;font-size:11px;line-height:17px}
.ptSchemaFacts dt{color:var(--pt-text-3)}
.ptSchemaFacts dd{margin:0;min-width:0;color:var(--pt-text-2);overflow-wrap:anywhere}
.ptSchemaEnumList{display:grid;grid-template-columns:repeat(auto-fill,minmax(7em,1fr));gap:2px 6px}
.ptSchemaEnum{min-width:0;padding:0 5px;border:.5px solid var(--pt-line-2);border-radius:3px;background:var(--pt-surface-1);font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:11px;color:var(--pt-text-2);overflow-wrap:anywhere}
/* 子参数：缩进 + 左侧竖线表达层级，每一层仍沿用「头行 + 说明」的版式。 */
.ptSchemaChildren{margin:2px 0 0 2px;padding-left:10px;border-left:.5px solid var(--pt-line-2);display:flex;flex-direction:column;gap:4px}
.ptSchemaGroupLabel{margin:0;color:var(--pt-text-3);font-size:10.5px;line-height:15px}
.ptSchemaNote{margin:0;color:var(--pt-text-3);font-size:11.5px;line-height:17px}
/* 卡片：应用面板、编辑器设置这类「一组动作 / 一组设置」的容器。 */
.ptCard{background:var(--pt-surface-1);border:.5px solid var(--pt-line-2);border-radius:var(--pt-r-lg);padding:14px 16px;margin:0 0 14px;display:flex;flex-direction:column;gap:8px}
.ptCardHead{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.ptCardTitle{margin:0;font-size:12.5px;font-weight:600}
.ptCardRow{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
/* 行内单选：选中项加粗，其余保持次要色。 */
.ptRadio{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--pt-text-2);cursor:pointer}
.ptRadio input{cursor:pointer;margin:0}
.ptRadio input:checked+span{color:var(--pt-text-1);font-weight:600}
.ptCardActions{display:flex;align-items:center;gap:8px;margin-left:auto}
.ptDangerCard{border-color:var(--pt-error-line)}
.ptWarnCard{border-color:var(--pt-warn-line)}
/* 提示词模板绑定的信息区：改动清单，默认收起。 */
.ptChangeList{display:flex;flex-direction:column;gap:8px}
.ptChangeText{margin:0;font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:11.5px;line-height:18px;white-space:pre-wrap;overflow-wrap:anywhere;color:var(--pt-text-2);background:var(--pt-surface-2);border:.5px solid var(--pt-line-2);border-radius:var(--pt-r-sm);padding:8px 10px}
/* 操作区：开关与清理各占一行，破坏性动作不和主开关挤在一起。 */
.ptBindingActions{display:flex;flex-direction:column;align-items:flex-start;gap:5px}
/* 本会话清理是这一列唯一的破坏性动作：字号与正文对齐，别缩成一行脚注。 */
.ptBindingActions .ptTextBtn{font-size:13px;padding:4px 6px}
/* 确认弹窗：覆盖层 + 居中卡片；点遮罩或 Esc 取消，初始焦点在取消上。 */
.ptModalOverlay{position:fixed;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;padding:24px;background:var(--pt-scrim)}
.ptModal{box-sizing:border-box;width:min(440px,100%);background:var(--pt-surface-2);border:.5px solid var(--pt-line-2);border-radius:var(--pt-r-lg);box-shadow:var(--pt-shadow);padding:16px 18px;display:flex;flex-direction:column;gap:10px}
.ptModalTitle{margin:0;font-size:13px;font-weight:600;line-height:20px}
.ptModalActions{display:flex;justify-content:flex-end;gap:8px;margin-top:2px}
/* 首次请求里的消息序列：每类消息一个子区块，按日志顺序竖排。 */
.ptMessageList{display:flex;flex-direction:column;gap:12px}
/* 页底唯一主动作：定制上下文。 */
.ptBottomAction{display:flex;justify-content:center;margin:30px 0 10px}
/* 按插件来源分组：分组本身是可折叠块，摘要沿用来源头排版，展开时才画分隔线。 */
.ptOwnerGroup{margin:0 0 8px;border:.5px solid var(--pt-line-2);border-radius:var(--pt-r-md);background:var(--pt-surface-2);overflow:hidden}
/* 分组已经在一个区块容器里时不再套一层壳：分组之间只用一条 hairline 分隔。 */
.ptSectionFold .ptOwnerGroup{margin:0;border:0;border-radius:0;background:transparent}
.ptSectionFold .ptOwnerGroup+.ptOwnerGroup{border-top:.5px solid var(--pt-line-2)}
.ptSectionFold .ptOwnerHead{padding:8px 0 6px;border-bottom:0}
.ptSectionFold .ptOwnerBody{padding:0 0 8px}
.ptOwnerName{border:0;background:transparent;color:var(--pt-accent);font:inherit;font-size:12px;font-weight:600;padding:0;cursor:pointer;text-align:left;overflow-wrap:anywhere}
.ptOwnerName:hover{text-decoration:underline}
.ptOwnerBody{padding:4px 8px 8px}
/* 开关 */
.ptSwitch{display:inline-flex;align-items:center;gap:7px;border:0;background:transparent;color:var(--pt-text-2);font:inherit;font-size:12px;padding:1px 2px;cursor:pointer;border-radius:var(--pt-r-sm);text-align:left}
.ptSwitch:disabled{opacity:.5;cursor:default}
.ptSwitch:focus-visible{outline:2px solid var(--pt-focus);outline-offset:2px}
.ptSwitchTrack{position:relative;flex:none;width:26px;height:15px;border-radius:999px;background:var(--pt-surface-3);transition:background .12s ease}
.ptSwitchKnob{position:absolute;top:2px;left:2px;width:11px;height:11px;border-radius:50%;background:var(--pt-knob);box-shadow:var(--pt-knob-shadow);transition:transform .12s ease}
.ptSwitch[aria-checked=true] .ptSwitchTrack{background:var(--pt-accent)}
.ptSwitch[aria-checked=true] .ptSwitchKnob{transform:translateX(11px)}
.ptSwitch[aria-checked=true] .ptSwitchLabel{color:var(--pt-text-1)}
.ptBindingRow{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:2px 8px 8px 26px;font-size:11.5px}
/* 编辑器 */
.ptEditor{box-sizing:border-box;width:100%;min-height:84px;resize:vertical;field-sizing:content;border:.5px solid var(--pt-line-2);border-radius:var(--pt-r-md);background:var(--pt-surface-2);color:inherit;font:inherit;font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:11.5px;line-height:18px;padding:8px 10px;outline:none}
.ptEditor:focus{border-color:var(--pt-accent)}
.ptEditor:disabled{opacity:.55;cursor:not-allowed}
.ptEditorLabel{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--pt-text-3);flex-wrap:wrap}
.ptToolGrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:1px 6px}
.ptToolCheck{display:flex;align-items:center;gap:6px;min-height:24px;font-size:11.5px;padding:3px 6px;border-radius:var(--pt-r-sm);min-width:0}
.ptToolCheck:hover{background:var(--pt-hover)}
.ptToolCheck code{font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:pointer}
.ptToolCheck[data-off=true] code{color:var(--pt-text-3);text-decoration:line-through}
/* 小胶囊：只用于编辑器里少数即时筛选。 */
.ptChipGroup{display:flex;flex-wrap:wrap;gap:5px;align-items:center}
.ptChip{border:.5px solid var(--pt-line-2);border-radius:var(--pt-r-sm);background:transparent;color:var(--pt-text-2);height:24px;padding:0 9px;font:inherit;font-size:11px;cursor:pointer;white-space:nowrap}
.ptChip:hover{background:var(--pt-hover)}
.ptChip[aria-pressed=true]{border-color:var(--pt-accent);color:var(--pt-text-1);background:var(--pt-surface-1)}
.ptChip:focus-visible{outline:2px solid var(--pt-focus);outline-offset:1px}
.ptLink{cursor:pointer;border:0;background:transparent;color:var(--pt-accent);padding:0 4px;border-radius:var(--pt-r-xs);text-align:left}
.ptLink:hover{background:var(--pt-accent-soft)}
.ptLink:focus-visible{outline:2px solid var(--pt-focus);outline-offset:1px}
.ptHint{margin:0 0 10px;color:var(--pt-text-3);font-size:11.5px;line-height:18px}
/* 关注项：插件页顶部的诊断列表，默认只在有严重项时展开。 */
.ptAttention{border:.5px solid var(--pt-line-2);border-radius:var(--pt-r-md);margin:4px 0 10px;background:var(--pt-surface-1);overflow:hidden}
.ptAttention>summary{display:flex;align-items:center;gap:8px;padding:6px 10px;cursor:pointer;list-style:none;font-size:12.5px;line-height:20px}
.ptAttention>summary::-webkit-details-marker{display:none}
.ptAttention>summary:hover{background:var(--pt-hover)}
.ptAttention>summary:focus-visible{outline:2px solid var(--pt-focus);outline-offset:-2px}
.ptAttention[open]>summary{border-bottom:.5px solid var(--pt-line-2);background:var(--pt-surface-2)}
.ptAttentionList{margin:0;padding:0;list-style:none}
.ptAttentionRow{display:flex;align-items:baseline;gap:8px;padding:6px 10px;border-top:.5px solid var(--pt-line-2);font-size:12px;line-height:18px}
.ptAttentionRow:first-child{border-top:0}
.ptAttentionRow[data-severity=critical]{background:var(--pt-error-soft)}
.ptSeverity{flex:none;font-size:10px;line-height:16px;padding:0 5px;border-radius:var(--pt-r-xs);color:var(--pt-text-3);background:var(--pt-surface-3);white-space:nowrap}
.ptSeverity[data-severity=critical]{color:var(--pt-error);background:var(--pt-error-soft)}
.ptSeverity[data-severity=warning]{color:var(--pt-warn);background:var(--pt-warn-soft)}
.ptAttentionText{display:flex;flex-direction:column;gap:1px;min-width:0;flex:1}
.ptAttentionTitle{color:var(--pt-text-1);overflow-wrap:anywhere}
.ptAttentionDetail{color:var(--pt-text-3);font-size:11px;line-height:16px;overflow-wrap:anywhere;font-family:var(--ds-font-family-code,ui-monospace,monospace)}
/* 破坏性清理：收起时只留一行居中小字，点开才是清理卡；再点一次收起。 */
.ptCleanupFold{margin:26px 0 6px;border:0;background:transparent}
.ptCleanupFold>.ptCleanupSummary{display:flex;align-items:center;justify-content:center;gap:5px;width:max-content;max-width:100%;margin:0 auto;padding:5px 9px;border-radius:var(--pt-r-sm);list-style:none;cursor:pointer;color:var(--pt-text-3);font-size:11.5px;line-height:18px}
.ptCleanupFold>.ptCleanupSummary::-webkit-details-marker{display:none}
.ptCleanupFold>.ptCleanupSummary:hover{color:var(--pt-text-1);background:var(--pt-hover)}
.ptCleanupFold>.ptCleanupSummary:focus-visible{outline:2px solid var(--pt-focus);outline-offset:1px}
/* 三角用边框画而不是字形：字号再小也不会退化成一个小点。 */
.ptCleanupCaret{display:inline-block;width:0;height:0;border-left:4px solid transparent;border-right:4px solid transparent;border-top:5px solid currentColor;transition:transform .12s ease}
.ptCleanupFold[open]>.ptCleanupSummary{margin-bottom:10px}
.ptCleanupFold[open]>.ptCleanupSummary .ptCleanupCaret{transform:rotate(180deg)}
.ptCleanupFold>.ptCard{margin:0}
@media (max-width:767px){.ptBar{padding:16px 16px 0}.ptBody{padding:0 16px 32px}.ptSearch{max-width:none}.ptDetail{margin-left:0}.ptDetailGrid{grid-template-columns:1fr}}
`

    /** 把模块级样式挂到 document 上，重复 materialize 不会重复插入。 */
    function ensureStyles() {
      if (typeof document === 'undefined') return
      if (document.querySelector(`style[data-plugin-css="${TAG_ID}"]`)) return
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-plugin-console'
      tag.dataset.pluginCss = TAG_ID
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    return { CSS, ensureStyles }
  },
})
