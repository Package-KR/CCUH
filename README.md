<div align="center">

<h1>CCUH</h1>
<p><strong>Codex Computer Use Helper</strong></p>
<p>A macOS companion for reliable app and window targeting in Codex Computer Use.</p>

<p><a href="./README.md">English</a> | <a href="./README.ko.md">한국어</a></p>

</div>

> [!WARNING]
> **Under active development.**

## The Problem

Computer Use depends on the intended app and window matching what Codex actually observes and where its input goes. CCUH was motivated by sessions where that connection was unreliable:

- Selecting an app could still bind observations and input to the wrong window.
- Switching windows during normal Mac use could disrupt the expected target.
- Repeated attempts continued silently, hiding targeting failures.

CCUH's goal is dependable Computer Use while you keep using your Mac. The intended target should be maintained and verified, and targeting failures should be surfaced promptly rather than silently retried.

## How It Works

The CCUH plugin bundles a local MCP server, Codex hooks, and a companion skill to make tool-call behavior observable:

- **Observe:** hooks record metadata before and after supported Computer Use calls.
- **Pair:** records are grouped by session and tool-call identifiers, keeping incomplete or conflicting pairs visible.
- **Inspect:** MCP tools expose connection diagnostics and recent call records inside Codex.
- **Guide:** the bundled skill provides app and window targeting guidance, including when to surface failures.

The MCP server runs as a local Node process on your Mac. No external server deployment or OpenAI API key is required.

CCUH's hooks and companion skill apply only to bundled Computer Use tasks. Coding, terminal commands, web search, and other MCP tools do not trigger observation. Codex may keep the MCP connection available while idle; this does not start window control or background monitoring.

## Get Started

You need **macOS**, **Node.js 24 or later**, and **Codex App or Codex CLI** with Computer Use configured. Node.js must be available to the Codex process; CCUH uses your installed Node.js and does not bundle it.

### 1. Add the marketplace

```bash
codex plugin marketplace add Package-KR/CCUH
```

### 2. Install the plugin

Open **Plugins** in Codex App, or enter `/plugins` in Codex CLI. Find **CCUH** in the `ccuh` marketplace and install it.

The plugin provides the MCP server, Computer Use hooks, and companion skill together. You do not need to edit MCP server or user hook configuration files.

### 3. Review and restart

If Codex prompts for hook review, review and trust the CCUH hooks in your client. In Codex CLI, open `/hooks`.

Restart Codex App or start a new Codex CLI session, depending on which client you use. Then use CCUH during your Computer Use task.

<details>
<summary>Manual fallback</summary>

Use one registration route. Do not enable the native plugin and manual registration at the same time.

If you cannot use the native plugin, run:

```bash
npx --yes github:Package-KR/CCUH setup
```

This installs a persistent local runtime in `~/.codex/ccuh/runtime`, registers the MCP server and Computer Use hooks, and backs up configuration before changing it. Existing MCP servers and hooks are preserved.

Review the CCUH hooks when Codex prompts you. In Codex CLI, open `/hooks`. Then restart the Codex client or session you use.

</details>

## Usage

Ask Codex:

> While carrying out my app task with Computer Use, use CCUH to verify the intended window and report targeting failures.

| Tool                | Purpose                                                                 |
| ------------------- | ----------------------------------------------------------------------- |
| `ccuh_status`       | Check the MCP response and summarize observation records                |
| `ccuh_recent_calls` | Inspect recent calls, paired events, and missing or conflicting records |

An MCP response confirms connectivity. Real hook records show whether automatic observation is running.

## Updates

After changes reach `main`, GitHub Actions validates the build and `github-actions[bot]` publishes the next patch version, version commit, tag, and GitHub Release. Users do not need a development checkout or a rebuild.

Codex handles marketplace refresh and installed plugin updates. CCUH does not add a background updater or modify its installed cache. If an update has not appeared, refresh the marketplace:

```bash
codex plugin marketplace upgrade ccuh
```

Codex may request review of changed hooks. If your client still uses the previous version after refreshing, start a new chat or restart the app.

<details>
<summary>Release maintenance</summary>

Develop on `dev` and merge reviewed changes into `main`. The **CI** workflow checks types, builds the runtime, and checks the native Swift sources on `dev` pushes and pull requests to `dev` or `main`. It does not publish a version.

The **Release** workflow keeps the package, lock file, plugin manifest, and runtime version in sync. It builds before publishing and uses the repository's `GITHUB_TOKEN`; allow GitHub Actions to write to `main` and release tags.

For a minor or major increment, run **Actions → Release → Run workflow** with the desired `bump`. If the version commit and tag succeeded but GitHub Release publication failed, rerun the failed publish job or set `repair_tag` to the existing tag. This publishes the same version without another increment.

Concurrent pushes are processed from the latest `main` and can be included in one release. A conflicting branch update stops publication without a force push.

</details>

## Data

Records are stored in `~/.codex/ccuh/state/events.jsonl` by default. They contain metadata such as timestamps, tool names, input-field types, and hashed identifiers.

Raw code, chat content, screenshots, and credentials are not stored.

Collection accepts only `mcp__cua_repl__js` and `mcp__cua_repl__js_reset`. Unknown tool names are excluded. Existing files are preserved; entries outside this scope are ignored when reading records.

The observed pre/post time difference includes hook, process, and storage overhead. It is not an app or window acquisition benchmark.

## License

CCUH is distributed under the [MIT License](LICENSE).
