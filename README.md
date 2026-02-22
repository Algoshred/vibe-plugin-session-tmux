# @burdenoff/vibe-plugin-session-tmux

Tmux + ttyd session provider plugin for [VibeControls Agent](https://www.npmjs.com/package/@burdenoff/vibe-agent).

## Installation

```bash
vibe plugin install @burdenoff/vibe-plugin-session-tmux
```

Or install globally alongside the agent:

```bash
npm install -g @burdenoff/vibe-plugin-session-tmux
```

## Features

- **Tmux Sessions** -- Create, manage, and destroy tmux terminal sessions
- **ttyd Integration** -- Web terminal access via ttyd (auto-started per session)
- **Session Lifecycle** -- Full lifecycle management with health checks
- **Command Execution** -- Run commands in existing tmux sessions
- **Terminal Capture** -- Capture terminal output from running sessions
- **Port Management** -- Automatic free port allocation for ttyd instances

## Provider Interface

This plugin registers a `session` provider with the following capabilities:

| Method | Description |
| --- | --- |
| `create(config)` | Create a new tmux session with optional ttyd terminal |
| `get(id)` | Get session info by ID |
| `list()` | List all managed sessions |
| `terminate(id)` | Kill a tmux session and its ttyd process |
| `execute(id, command)` | Send a command to a tmux session |
| `capture(id)` | Capture current terminal output |
| `startTerminal(id)` | Start a ttyd web terminal for a session |
| `stopTerminal(id)` | Stop the ttyd process for a session |
| `healthCheck()` | Check tmux and ttyd health |
| `getSystemSessions()` | List all system tmux sessions |
| `getSystemTerminals()` | List all running ttyd processes |

## Requirements

- VibeControls Agent >= 2.0.0
- tmux installed on the host system
- ttyd installed on the host system (optional, for web terminals)
- Bun runtime >= 1.3.0

## License

Proprietary -- Copyright Burdenoff Consultancy Services Pvt. Ltd.
