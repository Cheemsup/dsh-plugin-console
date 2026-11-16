/**
 * 提示词模板草稿的纯函数：草稿指纹、基线 → 草稿、草稿 → 配方。
 *
 * 这里不碰 React、不碰 DOM，也不依赖其它 chunk。拆出来的理由很简单：
 * 编辑器文件的其余部分都在描述「长什么样、点了会怎样」，只有这几个函数
 * 描述「数据怎么变」，它们值得被单独看懂、单独验证。
 *
 * 草稿覆盖四类内容：system 段 / runtime-context 逐段 / pre-step 消息 / 工具。
 * `recipeFromDraft` 只写与基线不同的项，保持配方是「差异」而不是整份复制。
 *
 * 本文件是一个包内 chunk：入口用 `require.async('./client.draft.js')` 取它。
 */

window.__ModuleLoader__.load({
  id: 'dsh-plugin-console',
  chunk: 'client.draft.js',
  factory: () => {
    /** 找到一条预览消息。 */
    function messageOf(baseline, kind) {
      return (baseline?.messages ?? []).find((message) => message.sourceKind === kind)
    }

    /** 一段的基线文本（插值后的全文优先）。 */
    function baselineText(section) {
      return typeof section.rendered === 'string' ? section.rendered : (section.text ?? '')
    }

    /**
     * 基线里的 runtime-context 逐段文本。
     *
     * `baseline.contexts` 是注册表全量（可能文本为空），`runtime-context.parts`
     * 是模型实际收到的那几段（推导段只在这里）。两者合并后，parts 优先。
     * @param {object} baseline - 该条件的预演结果。
     * @returns {Object<string, string>} name → 基线文本。
     */
    function baselineContexts(baseline) {
      const contexts = {}
      for (const context of baseline?.contexts ?? []) {
        if (typeof context?.name !== 'string') continue
        contexts[context.name] = typeof context.text === 'string' ? context.text : ''
      }
      const runtime = messageOf(baseline, 'runtime-context')
      for (const part of runtime?.parts ?? []) {
        if (typeof part?.name !== 'string') continue
        contexts[part.name] = typeof part.text === 'string' ? part.text : ''
      }
      return contexts
    }

    /** 基线里的 instructions / time 正文；没有消息时为空串。 */
    function baselineMessageText(baseline, kind) {
      return messageOf(baseline, kind)?.text ?? ''
    }

    /** 基线里的 skill 目录条目：name → { listed, description }。 */
    function baselineCatalog(baseline) {
      const entries = {}
      for (const part of messageOf(baseline, 'skill-catalog')?.parts ?? []) {
        if (typeof part?.name !== 'string') continue
        entries[part.name] = {
          listed: true,
          description: typeof part.description === 'string' ? part.description : '',
        }
      }
      return entries
    }

    /**
     * 草稿指纹：只由「用户能改的东西」组成，用来判断有没有未保存改动。
     *
     * 换基线条件会把草稿整份重置，所以只要是「和上次载入/保存时不一样」，
     * 换条件就会丢东西，必须问一句。
     * @param {object} draft - 草稿。
     * @returns {string} 可比较的指纹。
     */
    function signatureOf(draft) {
      const catalog = draft.catalog ?? { hidden: false, entries: {} }
      return JSON.stringify([
        draft.append,
        Object.entries(draft.sections ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        [...(draft.disabled ?? [])].sort(),
        Object.entries(draft.contexts ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        [draft.instructions?.text ?? '', draft.instructions?.hidden === true],
        [draft.time?.text ?? '', draft.time?.mode ?? (draft.time?.hidden === true ? 'hide' : 'keep')],
        draft.runtimeHidden === true,
        [catalog.hidden === true, Object.entries(catalog.entries ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))],
      ])
    }

    /**
     * 用一份基线把草稿整份填好，再把提示词模板的覆盖叠上去。
     *
     * 填的是 `rendered`（插值后的文本）而不是 `text`（原文）：用户要改的是
     * 模型真正会收到的那段字，`{{model}}` 之类的占位符在这里已经是实际值。
     * 物化时同名覆盖是 `interpolate: false` 直接使用的，所以两边口径一致。
     * @param {object} baseline - 该条件的预演结果。
     * @param {object} [recipe] - 要叠加的提示词模板配方。
     * @returns {object} 草稿状态。
     */
    function draftFromBaseline(baseline, recipe) {
      const sections = {}
      for (const section of baseline?.sections ?? []) {
        sections[section.name] = baselineText(section)
      }
      // 覆盖只落在「新基线里也存在的段」上。新基线没有的段直接忽略——
      // 凭空造一段不存在的东西，模型不会收到，用户也看不到。
      for (const [name, text] of Object.entries(recipe?.prompt?.sectionOverrides ?? {})) {
        if (typeof text === 'string' && sections[name] !== undefined) sections[name] = text
      }

      const contexts = baselineContexts(baseline)
      for (const [name, text] of Object.entries(recipe?.contexts ?? {})) {
        if (typeof text === 'string' && contexts[name] !== undefined) contexts[name] = text
      }

      const messages = recipe?.messages ?? {}
      const instructionsSpec = messages['agent-instructions'] ?? {}
      const timeSpec = messages['time-context'] ?? {}
      const catalogSpec = messages['skill-catalog'] ?? {}
      const catalogEntries = baselineCatalog(baseline)
      const hiddenEntries = new Set(Array.isArray(catalogSpec.hiddenEntries) ? catalogSpec.hiddenEntries : [])
      for (const [name, entry] of Object.entries(catalogEntries)) {
        if (hiddenEntries.has(name)) entry.listed = false
      }
      for (const [name, description] of Object.entries(catalogSpec.descriptions ?? {})) {
        if (catalogEntries[name] !== undefined && typeof description === 'string') {
          catalogEntries[name].description = description
        }
      }

      // 时间快照三态：hide = 不注入；keep = 不做修改（DSH 每轮重新注入）；
      // rewrite = 静态改写。没有覆盖时默认「不做修改」，即保持 DSH 的动态注入。
      const timeMode = timeSpec.hidden === true || timeSpec.text === ''
        ? 'hide'
        : typeof timeSpec.text === 'string'
          ? 'rewrite'
          : 'keep'

      return {
        append: typeof recipe?.prompt?.appendText === 'string' ? recipe.prompt.appendText : '',
        sections,
        disabled: new Set(Array.isArray(recipe?.tools?.disabled) ? recipe.tools.disabled : []),
        contexts,
        instructions: {
          text: typeof instructionsSpec.text === 'string'
            ? instructionsSpec.text
            : baselineMessageText(baseline, 'agent-instructions'),
          hidden: instructionsSpec.hidden === true || instructionsSpec.text === '',
        },
        time: {
          text: typeof timeSpec.text === 'string'
            ? timeSpec.text
            : baselineMessageText(baseline, 'time-context'),
          mode: timeMode,
          // 保留 hidden 供草稿指纹与旧断言使用；mode 才是界面的选择。
          hidden: timeMode === 'hide',
        },
        runtimeHidden: messages['runtime-context']?.hidden === true,
        catalog: {
          hidden: catalogSpec.hidden === true,
          entries: catalogEntries,
        },
      }
    }

    /**
     * 从当前草稿算出要写进 recipe 的内容。
     *
     * 只保留**与基线不同**的项：草稿里是全文，recipe 里只放差异。
     * 这样 recipe 保持在几百字节到几 KB 量级，也不会把 25 段原文整份复制进存储。
     *
     * 独占型提示词（`completeSection`）下没有「追加段落」这回事——独占段会把
     * 其余段全部丢弃，所以追加内容只能并进那一段。这里在算 recipe 时就折进去，
     * 存下来的是那一段的完整新文本。
     * @param {object} draft - 草稿与基线。
     * @returns {object} 提示词模板配方。
     */
    function recipeFromDraft(draft) {
      const { editPreview } = draft
      // 草稿统一使用 `draftFromBaseline` 的形状：append / sections / disabled。
      const draftAppend = draft.append ?? ''
      const draftSections = draft.sections ?? {}
      const draftDisabled = draft.disabled ?? new Set()
      const overrides = {}
      const completeName = editPreview?.completeSection ?? null
      for (const section of editPreview?.sections ?? []) {
        const baseline = baselineText(section)
        const current = draftSections?.[section.name]
        if (typeof current === 'string' && current !== baseline) overrides[section.name] = current
      }
      // 独占段：把追加段落并进去
      if (completeName !== null && (draftAppend ?? '').trim().length > 0) {
        const current = overrides[completeName]
          ?? (editPreview?.sections ?? []).find((section) => section.name === completeName)?.rendered
          ?? ''
        overrides[completeName] = current.length > 0 ? current + '\n\n' + draftAppend : draftAppend
      }

      // runtime-context：只写与基线不同的段。
      const baselineContextsMap = baselineContexts(editPreview)
      const contexts = {}
      for (const [name, text] of Object.entries(draft.contexts ?? {})) {
        if (typeof text !== 'string' || baselineContextsMap[name] === undefined) continue
        if (text !== baselineContextsMap[name]) contexts[name] = text
      }

      // pre-step 消息：逐类只写差异。
      const messages = {}
      const baselineInstructions = baselineMessageText(editPreview, 'agent-instructions')
      if (draft.instructions?.hidden === true) {
        if (baselineInstructions.length > 0) messages['agent-instructions'] = { hidden: true }
      } else if (typeof draft.instructions?.text === 'string' && draft.instructions.text !== baselineInstructions) {
        messages['agent-instructions'] = { text: draft.instructions.text }
      }

      const baselineTime = baselineMessageText(editPreview, 'time-context')
      const timeMode = draft.time?.mode ?? (draft.time?.hidden === true ? 'hide' : 'keep')
      if (timeMode === 'hide') {
        if (baselineTime.length > 0) messages['time-context'] = { hidden: true }
      } else if (timeMode === 'rewrite') {
        messages['time-context'] = {
          text: typeof draft.time?.text === 'string' ? draft.time.text : baselineTime,
        }
      }
      // keep：不写字段。配方缺省就是「不做修改」，DSH 每轮重新注入。

      if (draft.runtimeHidden === true) messages['runtime-context'] = { hidden: true }

      const baselineCatalogMap = baselineCatalog(editPreview)
      const catalogSpec = draft.catalog ?? { hidden: false, entries: {} }
      if (catalogSpec.hidden === true && Object.keys(baselineCatalogMap).length > 0) {
        messages['skill-catalog'] = { hidden: true }
      } else {
        const hiddenEntries = []
        const descriptions = {}
        for (const [name, entry] of Object.entries(catalogSpec.entries ?? {})) {
          const baseline = baselineCatalogMap[name]
          if (baseline === undefined) continue
          if (entry.listed === false && baseline.listed === true) hiddenEntries.push(name)
          if (entry.description !== baseline.description) descriptions[name] = entry.description
        }
        if (hiddenEntries.length > 0 || Object.keys(descriptions).length > 0) {
          messages['skill-catalog'] = {
            ...(hiddenEntries.length > 0 ? { hiddenEntries } : {}),
            ...(Object.keys(descriptions).length > 0 ? { descriptions } : {}),
          }
        }
      }

      return {
        prompt: {
          ...((draftAppend ?? '').trim().length > 0 && completeName === null ? { appendText: draftAppend } : {}),
          ...(Object.keys(overrides).length > 0 ? { sectionOverrides: overrides } : {}),
        },
        ...(Object.keys(contexts).length > 0 ? { contexts } : {}),
        ...(Object.keys(messages).length > 0 ? { messages } : {}),
        tools: { disabled: [...(draftDisabled ?? [])] },
      }
    }

    /**
     * 一份 recipe 的可见规模。
     *
     * 保存/应用后把它写进通知，用户不必打开存储文件就能确认
     * 「段落 / 追加 / 工具 / 上下文 / 消息」是否真的被记下来了。
     * @param {object} recipe - 提示词模板配方。
     * @returns {string} 一行摘要。
     */
    function recipeSummary(recipe) {
      const sections = Object.keys(recipe?.prompt?.sectionOverrides ?? {}).length
      const append = typeof recipe?.prompt?.appendText === 'string' && recipe.prompt.appendText.length > 0 ? 1 : 0
      const tools = Array.isArray(recipe?.tools?.disabled) ? recipe.tools.disabled.length : 0
      const contexts = Object.keys(recipe?.contexts ?? {}).length
      const messages = Object.keys(recipe?.messages ?? {}).length
      return `段落 ${sections} · 追加 ${append} · 工具 ${tools} · 上下文 ${contexts} · 消息 ${messages}`
    }

    return { signatureOf, draftFromBaseline, recipeFromDraft, recipeSummary, baselineText }
  },
})
