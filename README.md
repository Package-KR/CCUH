# CCUH

[한국어](README.ko.md)

CCUH (Codex Computer Use Helpers) helps Codex check the target and input path before a Computer Use task. It uses the official Computer Use feature in Codex desktop.

The current 0.1.0 preview is available on the [`release` branch](https://github.com/dijeungi/CCUH/tree/release).

## Install in Codex

Send this request once in a Codex chat.

```text
$skill-installer Install both skills/ccuh and skills/ccuh-doctor from the release branch of dijeungi/CCUH.
```

Start a new Codex chat after installation. Select either skill from the Skills menu, or let Codex choose it when a request matches its description.

- **`ccuh`** checks the target app or tab and helps choose a supported way to observe or interact with it.
- **`ccuh-doctor`** helps diagnose connection or permission errors and clarify the next action when a result is uncertain.

## Optional automatic hooks

The hook preview loads CCUH guidance before supported Computer Use calls. It requires macOS, the Codex CLI, and Python 3.9 or newer.

```sh
codex plugin marketplace add dijeungi/CCUH --ref release
codex plugin add ccuh@ccuh-preview
```

Review the CCUH hooks in **Settings → Hooks**, then open a new chat. [Hook preview guide](https://github.com/dijeungi/CCUH/tree/release#설치)

## License

[MIT](LICENSE)
