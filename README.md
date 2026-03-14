# Vibe Control

**A VSCode plugin that allows you to use Claude Code like you would ChatGPT.**

Vibe Control adds a sidebar session browser, cross-project workspace switching, and an HTTP API designed for [OpenClaw](https://github.com/anthropics/openclaw) and other automation agents to drive Claude Code programmatically.

---

## Features

### Session Management

- **Sidebar tree view** — all Claude Code sessions grouped by project, sorted by last modified time
- **Create sessions** — pick a name and project folder upfront; no more auto-generated titles
- **Rename / Delete** — right-click any session in the tree
- **Open / Resume** — click a session to jump back into it, even across projects
- **Single-tab mode** — clicking a session reuses the existing tab; right-click → "Open in New Tab" for a separate tab

### Cross-Project Workspace Switching

Right-click a session or project → **Switch Workspace**.

Uses a multi-root workspace with an anchor folder so VSCode swaps the active project folder **without reloading the window**.

### Per-Session Project Binding

Each session remembers the `cwd` it was created with. Opening a session automatically sets the correct working directory for Claude Code, even when the workspace root is different.

### HTTP API for Automation Agents

An embedded HTTP server (default port `23816`) provides a REST + SSE interface specifically designed for **OpenClaw and other automation agents** to interact with Claude Code sessions programmatically — no manual UI interaction needed.

Use cases:
- **OpenClaw** orchestrating multi-session workflows across projects
- **Custom scripts** automating code reviews, batch refactoring, or CI integrations
- **Other AI agents** coordinating with Claude Code as a sub-agent
- **Monitoring dashboards** tracking session status and output in real time

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

## Quick Start

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
code --install-extension vibe-control-*.vsix
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

## Requirements

- VSCode ≥ 1.94
- [Claude Code extension](https://marketplace.visualstudio.com/items?itemName=Anthropic.claude-code) (auto-installed as dependency)

## Acknowledgments

This project was built entirely with the help of [Claude Code](https://docs.anthropic.com/en/docs/claude-code) by Anthropic. From architecture design to implementation, Claude Code served as an invaluable pair-programming partner throughout the development process.

## License

MIT

---

# Vibe Control（简体中文）

**一个让你像使用 ChatGPT 一样使用 Claude Code 的 VSCode 插件。**

Vibe Control 提供侧边栏会话浏览器、跨项目工作区切换，以及一套专为 [OpenClaw](https://github.com/anthropics/openclaw) 和其他自动化 Agent 设计的 HTTP API，用于以编程方式驱动 Claude Code。

---

## 功能

### 会话管理

- **侧边栏树形视图** — 所有 Claude Code 会话按项目分组，按最后修改时间排序
- **创建会话** — 预先选择名称和项目文件夹，告别自动生成的标题
- **重命名 / 删除** — 右键点击会话即可操作
- **打开 / 恢复** — 点击会话即可跳转，支持跨项目
- **单标签模式** — 点击会话复用当前标签页；右键 → "Open in New Tab" 可打开新标签页

### 跨项目工作区切换

右键会话或项目 → **Switch Workspace**。

利用多根工作区和锚定文件夹，VSCode 切换项目文件夹时**无需重载窗口**。

### 会话绑定项目路径

每个会话记住创建时的工作目录（`cwd`）。打开会话时自动为 Claude Code 设置正确的工作路径。

### 面向自动化 Agent 的 HTTP API

内置 HTTP 服务器（默认端口 `23816`），提供 REST + SSE 接口，**专为 OpenClaw 及其他自动化 Agent 设计**，可以编程方式操控 Claude Code 会话，无需手动 UI 操作。

适用场景：
- **OpenClaw** 编排跨项目的多会话工作流
- **自定义脚本** 自动化代码审查、批量重构或 CI 集成
- **其他 AI Agent** 将 Claude Code 作为子代理协同工作
- **监控面板** 实时追踪会话状态和输出

#### 会话接口

| 方法 | 路径 | 请求体 | 说明 |
|------|------|--------|------|
| `GET` | `/api/conversations` | — | 列出所有会话（可选 `?projectPath=` 过滤） |
| `GET` | `/api/conversations/:id` | — | 会话详情 + 完整消息历史 |
| `POST` | `/api/conversations` | `{name, projectPath, model}` | 创建新会话 |
| `DELETE` | `/api/conversations/:id` | — | 删除会话（同时停止进程） |
| `POST` | `/api/conversations/:id/rename` | `{name}` | 重命名会话 |

#### 消息与进程控制

| 方法 | 路径 | 请求体 | 说明 |
|------|------|--------|------|
| `POST` | `/api/conversations/:id/message` | `{message}` | 发送消息 → SSE 流式响应 |
| `GET` | `/api/conversations/:id/stream` | — | 订阅 SSE 输出流（不发送消息） |
| `GET` | `/api/conversations/:id/status` | — | 查询进程运行状态 |
| `POST` | `/api/conversations/:id/stop` | — | 停止进程（SIGTERM） |
| `POST` | `/api/conversations/:id/interrupt` | — | 中断进程（SIGINT，优雅停止） |
| `POST` | `/api/conversations/:id/model` | `{model}` | 切换模型 |

#### 权限审批

| 方法 | 路径 | 请求体 | 说明 |
|------|------|--------|------|
| `GET` | `/api/conversations/:id/permissions` | — | 列出待审批的权限请求 |
| `POST` | `/api/conversations/:id/permission` | `{requestId, allow}` | 审批回复 |

#### SSE 事件类型

通过 `/message` 或 `/stream` 端点推送：

| 事件 | 数据 |
|------|------|
| `data`（默认） | CLI JSON 输出（助手回复、工具调用等） |
| `permission_request` | `{requestId, sessionId, toolName, input}` |
| `permission_resolved` | `{requestId, allowed}` |
| `done` | `{code, error}` |
| `error` | `{error}` |

## 配置

| 设置项 | 默认值 | 说明 |
|--------|--------|------|
| `vibe-control.httpPort` | `23816` | HTTP API 服务器端口 |
| `vibe-control.enableHttpServer` | `true` | 启用 / 禁用 HTTP API |

## 依赖

- VSCode ≥ 1.94
- [Claude Code 扩展](https://marketplace.visualstudio.com/items?itemName=Anthropic.claude-code)（作为依赖自动安装）

## 致谢

本项目完全借助 Anthropic 的 [Claude Code](https://docs.anthropic.com/en/docs/claude-code) 构建。从架构设计到代码实现，Claude Code 在整个开发过程中都是不可或缺的结对编程伙伴。

## 许可证

MIT