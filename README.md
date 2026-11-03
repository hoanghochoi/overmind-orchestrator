# Overmind Orchestrator

Overmind Orchestrator is a trusted Paseo plugin for governed multi-agent work. It gives a project a Supervisor, Lead, and Peer workflow, keeps role-specific provider settings, routes delegated work and alerts, and records the evidence needed to review a task.

Overmind runs on the Paseo daemon host. Agents, provider credentials, notebooks, model caches, and plugin state stay on that host unless a configured provider or optional evaluator sends data elsewhere.

## What it adds

- Supervisor → Lead → Peer delegation with explicit ownership.
- A Supervisor-only `create_supervisor_wake` action for one scheduled wake of the current conversation.
- Provider-neutral adapters for Codex, Claude, OpenCode, Pi, Antigravity-compatible ACP, and generic CLIs.
- Overmind Command screen for setup, seat status, activity, alerts, and notebook review.
- Causal notebook stored per project in the plugin state directory.
- Detection of repeated anti-patterns and weak verification, with evidence routed to the owning role.
- Contract locks for test-generation work, bound to the owning Lead and workspace.
- Optional semantic alert scoring using a pinned local embedding model.
- Optional JEV review through TypeSafe, disabled by default.

## Requirements

- Paseo 0.13.2 or newer with plugins enabled.
- The provider CLIs or ACP providers selected in Overmind Settings.
- Provider authentication configured on the same daemon host.
- The Paseo CLI available through `PASEO_CLI` or `PATH` for scheduled Supervisor wakes. Desktop supplies `PASEO_CLI`.
- Node.js and npm only when installing from npm or when a plugin preparation step is declared.

The plugin does not include provider accounts or credentials. Each user configures those in Paseo on the host where the daemon runs.

## Install

The reviewed registry listing is the recommended distribution channel after publication:

```bash
paseo plugin add hoanghochoi/overmind-orchestrator
```

Until the registry listing is approved, install the public Git repository directly:

```bash
paseo plugin add git:hoanghochoi/overmind-orchestrator
```

For a daemon reached through Relay, run the command with the target daemon selected or install from that daemon's **Settings → Plugins** page. Plugin installation is per daemon; installing it on one host does not install it on another.

After installation:

1. Enable plugins in the target daemon's Settings.
2. Open **Settings → Plugins** and confirm `paseo-plugin-overmind` is `running`.
3. Open **Overmind** and configure the providers, models, thinking levels, and permission modes for new seats.
4. Reload or recreate existing Overmind seats after a plugin update so they receive the current role configuration.

## Data and network behavior

The plugin is trusted, unsandboxed Paseo code. Its server process can read and write files available to the daemon user and can launch the configured provider CLIs.

- Notebook and seat state are written under `~/.overmind/paseo-plugin/` on the daemon host.
- The default semantic sensor downloads pinned `all-MiniLM-L6-v2` model files from Hugging Face on first use. The cache is kept under `.cache/overmind-models` in the daemon user's home.
- JEV review is off by default. If enabled, Overmind sends the current objective, bounded agent output, and detected signals to `api.typesafe.ai`. The API key is stored in host-scoped plugin settings and is masked in the UI.
- Provider prompts and tool results follow the provider's own account and network configuration.

Do not enable JEV or configure a remote provider when project data must remain local.

## Development

```bash
npm install
npm run typecheck
npm test
npm pack --dry-run --ignore-scripts
```

The plugin is compiled by Paseo from `index.client.tsx` and `index.server.ts`; host SDK packages are development dependencies for typechecking. Runtime dependencies are listed separately so Paseo can install them for users.

Git installation runs the manifest's locked `npm ci --ignore-scripts` preparation step on the daemon host before Paseo compiles the plugin. This installs the host type packages and pinned runtime dependency tree; npm lifecycle scripts remain disabled.

To test a local directory plugin in a daemon:

```bash
paseo plugin install /absolute/path/to/overmind-orchestrator
paseo plugin ls paseo-plugin-overmind
paseo plugin logs paseo-plugin-overmind
```

Source changes require an explicit reload:

```bash
paseo plugin reload paseo-plugin-overmind
```

## Release and registry submission

1. Update the version and verify the manifest requirement.
2. Run typecheck, the focused test suite, and `npm pack --dry-run --ignore-scripts`.
3. Publish the package or tag the Git revision.
4. Submit the source through the [Paseo plugin registry form](https://github.com/getpaseo/plugins/issues/new?template=submit-plugin.yml).

The registry pins the reviewed version or commit. Future releases should keep the published overview, dependency lock, and data-flow disclosure current.

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
