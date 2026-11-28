# dsh-plugin-console

[简体中文](README.md) · [English](README_en.md)

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://opensource.org/license/mit)

A sidebar plugin console for DeepSeek Harness (DSH). It gathers plugin, session, and tool
information through runtime object analysis and raw source-file scanning, and presents it in the panel.
It also provides a model-context preview, a preview of the impact of disabling a plugin
and its config overrides, and matching context customization.

Suggestions, questions, and criticism are welcome.

## Features

- **Plugins** — browse the plugins installed on this machine; inspect enabled status, composition
  chain, service dependencies, registered effects, contributed tools and prompt sections, and
  understand how plugins behave and relate inside DSH.
- **Sessions** — follow the source chain from global plugins to the preset's plugins to this
  session, and read the first request's system prompt, tool schemas, injected messages, and more.
- **Tools** — view tools grouped by the plugin that registers them, or each mode's preset tool set,
  to trace where every tool comes from and see its details.
- **Context preview** — pick a mode, workspace, and permission preset to see the complete
  context the model will receive before the first message of a new session is sent.
- **Prompt customization templates** — a rule file managed by the plugin enables customization on
  top of DSH's standard model context, with a complete lifecycle for switching, inheritance, and
  cleanup.
- **Capability surface** — inspect three things beyond model tools: skills by workspace and mode
  (file path, source, model/user invocability, content on demand), the slash-command directory
  (host commands, builtin aliases, skill entries, and a source-scan fallback), and network
  capabilities (LLM/web providers, MCP status, declared inbound routes).
- **Plugin disable preview** — pick any plugin and preview what disabling it would remove: tools,
  prompt sections, and runtime injections. It also shows how the declared config differs from the
  effective value, and a dependency graph of upstream/downstream plugin relationships — laid out
  layer by layer, or switched to a network layout to read clusters and density. Click a node or
  edge to highlight the whole path through it; right-click a node to open its plugin page.

## Install

```sh
# From npm
# You can also add it from DSH's built-in plugin list by entering @cheemsup/dsh-plugin-console
dsh plugin --profile <profile> add @cheemsup/dsh-plugin-console

# From GitHub
dsh plugin --profile <profile> add github:Cheemsup/dsh-plugin-console

# From a local checkout (development)
dsh plugin --profile <profile> add file:<absolute path to this repo>
```

## Screens

### Plugins

![Plugins page](https://raw.githubusercontent.com/Cheemsup/dsh-plugin-console/main/docs/images/01-plugins.png)

*Figure 1 · The Plugins page shows plugin information, behavior, dependencies, and relationships
inside DSH.*

Plugin details split contributions into tools, prompt sections, and runtime contexts. Only names
with a target in the current first-request assembly jump to the context preview; subagent, session,
and conditional registrations expand in place with their registration site, receiver, and an
on-demand source snippet.

### Sessions

![Sessions page](https://raw.githubusercontent.com/Cheemsup/dsh-plugin-console/main/docs/images/02-sessions.png)

*Figure 2 · The Sessions page shows the plugins involved in a session and the complete
first-request context.*

### Tools

![Tools page](https://raw.githubusercontent.com/Cheemsup/dsh-plugin-console/main/docs/images/03-tools.png)

*Figure 3 · The Tools page answers "which tools the model can see, and who provided them." Sources
come from scanning plugin package source, presented in a readable form.*

### Context preview

![Context preview](https://raw.githubusercontent.com/Cheemsup/dsh-plugin-console/main/docs/images/04-preview.png)

*Figure 4 · The context preview page answers "if I started a new session now, what would the model
receive before my first message." Different workspaces and modes produce different preview results.*

### Prompt customization templates

![Editor](https://raw.githubusercontent.com/Cheemsup/dsh-plugin-console/main/docs/images/05-editor.png)

*Figure 5 · The editor: after choosing a workspace and mode, customize the prompt on top of the
preview and start a session.*

### Capability surface

The capability surface answers "what exists beyond model tools" in one page:

- **Skills** — the `ctx.skills` catalog for a workspace and mode, with file location, source,
  provider, model/manual usage, and discovery completeness; content is fetched on demand in full,
  without truncation.
- **Slash commands** — pick a session inside the chosen workspace (inactive sessions included;
  sessions outside any workspace fall back into the default workspace and are marked "ungrouped").
  A live session reads `commands.list(agent)`; an inactive session, or no session at all, reads the
  preset scope read-only and then falls back to source scanning. User-invocable skills appear as slash
  entries; client-side command contributions are not host-visible and are noted in the source chip's
  tooltip.
- **Network** — organised as controlled egress → direct calls → inbound routes. Direct calls and
  inbound routes are folded per plugin (direct calls are grouped by site inside each plugin), with
  third-party groups that provide no controlled channel flagged as inferred; the condition bar has a searchable
  plugin selector. Controlled egress lists LLM/web search/web fetch providers and MCP connection
  status. Endpoints, headers, and env values are never shown, and source targets are stripped of
  credentials and query strings.

### Plugin disable preview

![Plugin disable preview](https://raw.githubusercontent.com/Cheemsup/dsh-plugin-console/main/docs/images/06-disable-preview.png)

*Figure 6 · The plugin disable preview page: simulates what changes after disabling a plugin, such
as which prompts and tools are lost and how the impact propagates along dependency chains.*

## Data confidence

- **Runtime facts**: plugin entries and status, tool and prompt registrations, and session logs are
  read directly from the host.
- **Derived**: workspace, permissions, instruction files, skill catalog, and time snapshots are
  recomputed from the same config and files.
- **Source attribution**: the registry does not record who registered a tool, prompt section,
  command, skill, or provider, so plugin source is scanned to fill that in.
- **Capability surface**: skills and commands come from runtime registries; a command's
  `definitionId` and a skill's `provider` are package-level facts and take priority over the source
  scan. Inbound routes come from effect labels written at registration time and from `path`
  literals in source, each labelled separately.
- **Scope inference**: a registration site carries its file, line, and receiver; receivers such as
  `childCtx` / `scope` are only used to infer "another scope", never presented as a runtime fact.
- **File facts**: bundle / profile / home patch files and their config subtrees; unreadable files or
  unsupported syntax are reported with a reason.
- **Unknown / unavailable**: stated honestly when input is missing or the host exposes no read path;
  derived values are never presented as measured.

## Known limits

- Requires the host's `connection` service; without it the plugin loads but registers no routes.
- Cold sessions have no fiber: they show recorded facts and the preset's plugins, but not what this
  process actually mounted.
- The context preview is a prediction, not a record. Attachments/images, later turns, and
  dynamic injections such as goal / plan / schedule are out of scope; subagent first requests are not
  included.
- The prompt sections and runtime contexts listed on the Plugins page come from package source
  scanning; a name existing there does not mean it is registered in the current session. Every
  prompt contribution expands in place: the first level shows the injected text, and a second level
  shows when it is registered, its registration site, and a short source window. Only contributions
  with a target in the current mode's first-request assembly get a "preview" action; subagent,
  session, and conditional contributions show source evidence only. A contribution is tagged
  "unique source" when the name-level index has exactly this row, all its sites are in this scope,
  and the name is not a template. Owner tags on the context preview all read
  "possible plugin source, click to open" and do not distinguish name collisions.
  Both the text and the snippet are static source facts, not the text the model actually received.
- The capability surface does not record network request traffic: it shows provider registries,
  MCP connection status, route declarations, and source-level call sites (which do not prove a request
  happened) only; it does not intercept fetch or read proxy
  logs. The slash directory covers host commands plus user-invocable skills; client-side
  contributions (`ui-commands`) and client skill sources exist only in the browser.
- An inactive session (or no session) has no Agent: the command directory falls back to a read-only
  preset scope built from that session's recorded mode plus the chosen workspace, so commands
  registered only in the session scope are missing and the page says so. If no scope can be acquired
  it degrades to source scanning.
- Activity covers tool contributions only, over the last 7 days and at most 20 sessions
  (experimental). Plugins that only provide services or listen to events have no call counts.
- The plugin disable preview is derived; it does not disable anything or simulate an unload, and "lost" only
  means no other owner. The dependency chain is inferred from inject declarations and describes the
  state after a reload/restart; already-active plugins may keep their registrations until then. Config
  layers show patch declarations and the effective value only; patch merge semantics are not public,
  so diagnostics do not infer a cause. Built-in bundles, or a host without `pluginPackages`, make a
  bundle patch unreadable and the layer says so.
- Prompt customization **only affects model context, not actual permissions**, except for disabling
  tools.
- Clearing template data removes persisted records only; running sessions keep what they registered
  until they end or DSH restarts.

## Development

Architecture and constraints live in [CLAUDE.md](CLAUDE.md); UI rules in
[docs/design-ui.md](docs/design-ui.md); possible next steps in [docs/next-direction.md](docs/next-direction.md).

## License

MIT
