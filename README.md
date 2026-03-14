# Vibe Control

**A VSCode plugin that allows you to use Claude Code like you would ChatGPT.**

Vibe Control adds a sidebar session browser, cross-project workspace switching, and an HTTP API that lets external tools (scripts, other editors, automation) drive Claude Code programmatically.

## Features

### Session Management

- **Sidebar tree view** — all Claude Code sessions grouped by project, sorted by last modified time
- **Create sessions** — pick a name and project folder upfront; no more auto-generated titles
- **Rename / Delete** — right-click any session in the tree
- **Open / Resume** — click a session to jump back into it, even if it belongs to a different project

### Cross-Project Workspace Switching

Right-click a session or project folder → **Switch Workspace**.

Uses a multi-root workspace with an anchor folder so VSCode swaps the active project folder **without reloading the window**. The anchor folder stays at workspace index 0; your project folder lives at index 1.

### Per-Session Project Binding

Each session remembers the `cwd` it was created with. Opening a session automatically sets the correct working directory for Claude Code, even when the workspace root is different.

### HTTP API

An embedded HTTP server (default port `23816`) exposes a REST + SSE interface for external tools.

#### Session endpoints

| Method | Path | Body | Description |
|--------|------|------|-------------|
| `GET` | `/api/conversations` | — | List all sessions (optional `?projectPath=` filter) |
| `GET` | `/api/conversations/:id` | — | Session details + full message history |
| `POST` | `/api/conversations` | `{name, projectPath, model}` | Create a new session |
| `DELETE` | `/api/conversations/:id` | — | Delete session (stops process too) |
| `POST` | `/api/conversations/:id/rename` | `{name}` | Rename session |

#### Messaging & process control

| Method | Path | Body | Description |
|--------|------|------|-------------|
| `POST` | `/api/conversations/:id/message` | `{message}` | Send message → SSE streamed response |
| `GET` | `/api/conversations/:id/stream` | — | Subscribe to SSE output (no message sent) |
| `GET` | `/api/conversations/:id/status` | — | Process running state |
| `POST` | `/api/conversations/:id/stop` | — | SIGTERM the process |
| `POST` | `/api/conversations/:id/interrupt` | — | SIGINT (graceful stop) |
| `POST` | `/api/conversations/:id/model` | `{model}` | Switch model |

#### Permission handling

| Method | Path | Body | Description |
|--------|------|------|-------------|
| `GET` | `/api/conversations/:id/permissions` | — | List pending permission requests |
| `POST` | `/api/conversations/:id/permission` | `{requestId, allow}` | Approve or deny |

#### SSE event types

Events pushed via `/message` or `/stream`:

| Event | Payload |
|-------|---------|
| `data` (default) | CLI JSON output (assistant replies, tool calls, …) |
| `permission_request` | `{requestId, sessionId, toolName, input}` |
| `permission_resolved` | `{requestId, allowed}` |
| `done` | `{code, error}` |
| `error` | `{error}` |

## Quick start

```bash
# Install dependencies
npm install

# Build
npm run compile

# Dev mode (auto-rebuild on save)
npm run watch
```

Then press **F5** in VSCode to launch the Extension Development Host, or install the `.vsix`:

```bash
npx @vscode/vsce package
code --install-extension vibe-control-0.0.1.vsix
```

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `vibe-control.httpPort` | `23816` | HTTP API server port |
| `vibe-control.enableHttpServer` | `true` | Enable / disable the HTTP API |

## Architecture

```
src/
├── extension.ts            # Activation, commands, workspace switching
├── sessionManager.ts       # Reads ~/.claude/projects/ session files
├── sessionTreeProvider.ts  # Sidebar tree view UI
├── processManager.ts       # Spawns Claude Code CLI, SSE streaming
├── httpServer.ts           # REST API + SSE server
└── types.ts                # Shared interfaces
```

**Key design decisions:**

- **Anchor-folder workspace** — a hidden anchor folder at index 0 keeps VSCode in multi-root mode so `updateWorkspaceFolders` never triggers a reload
- **Global CWD override** — patches Claude Code's extension.js to read `global.__vibeControlCwd`, enabling per-session project paths without multiple windows
- **JSONL tail reading** — session metadata (title, branch, cwd) is extracted from the tail of `.jsonl` files, matching Claude Code's own reading strategy

## Requirements

- VSCode ≥ 1.94
- [Claude Code extension](https://marketplace.visualstudio.com/items?itemName=Anthropic.claude-code) installed

## Acknowledgments

This project was built entirely with the help of [Claude Code](https://docs.anthropic.com/en/docs/claude-code) by Anthropic. From architecture design to implementation, Claude Code served as an invaluable pair-programming partner throughout the development process.

## License

MIT