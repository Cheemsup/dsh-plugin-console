# dsh-plugin-console

[简体中文](README.md) · [English](README_en.md)

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://opensource.org/license/mit)

A sidebar plugin console for DeepSeek Harness (DSH). It gathers plugin, session, and tool
information through runtime object analysis and raw source-file scanning, and presents it in the panel.
It also provides a model-context preview, a preview of the impact of disabling a plugin
and its config overrides, and matching context customization.

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
- **Plugin disable preview** — pick any plugin and preview what disabling it would remove: tools, prompt
  sections, and runtime injections. It walks the dependency chain to a fixpoint — a consumer is
  blocked only when every provider of a required service is gone — and lists every plugin that would
  become unavailable, the service it loses, and the full causal path. It also shows each
  composition layer's (bundle / profile / home / launch overlay) declared config next to the
  effective value, and a tree of upstream/downstream plugin relationships. The page is read-only and
  never disables anything.
- **Prompt customization templates** — a rule file managed by the plugin enables customization on
  top of DSH's standard model context, with a complete lifecycle for switching, inheritance, and
  cleanup.

## Install

```sh
# From npm
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

### Plugin disable preview

Answers "what would happen, and who would be affected, if I disabled this plugin." The body has two
parts: the plugin being disabled, and the chain reaction. The chain reaction answers exactly two
questions — which tools and prompts would become unavailable (including downstream contributions),
and which downstream plugins would be affected. The impact is derived: "lost" only means no other
owner. The dependency chain is computed to a fixpoint — a
consumer is blocked only when every provider of a required service is gone — and every level lists
its missing service and full causal path from the target. The dependency graph and config layers sit
in separate blocks below. Config layers show the patch file's declaration next to the loader's
effective value, and unreadable layers say why; injected-message ownership and group children are
marked as inference. The page is read-only; disabling still happens in the plugin detail's control
section.

## Data confidence

- **Runtime facts**: plugin entries and status, tool and prompt registrations, and session logs are
  read directly from the host.
- **Derived**: workspace, permissions, instruction files, skill catalog, and time snapshots are
  recomputed from the same config and files.
- **Source attribution**: the registry does not record who registered a tool or prompt section, so
  plugin source is scanned to fill that in.
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
