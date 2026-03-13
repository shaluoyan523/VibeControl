import * as child_process from 'child_process';
import * as path from 'path';
import * as http from 'http';

export type ProcessStatus = 'running' | 'idle' | 'error' | 'not_started';

export interface PendingPermission {
  requestId: string;
  sessionId: string;
  toolName: string;
  input: any;
  timestamp: number;
}

interface ProcessInfo {
  sessionId: string;
  process: child_process.ChildProcess;
  status: 'running' | 'idle' | 'error';
  model: string;
  cwd: string;
  lastError?: string;
  sseClients: Set<http.ServerResponse>;
  buffer: string;
  pendingPermissions: Map<string, PendingPermission>;
}

export class ProcessManager {
  private processes = new Map<string, ProcessInfo>();
  private cliPath: string;
  private models = new Map<string, string>();

  constructor(extensionPath: string) {
    const localCli = path.join(extensionPath, 'resources', 'claude-code', 'cli.js');
    const originalCli = path.join(
      process.env.HOME || '',
      '.windsurf-server', 'extensions',
      'anthropic.claude-code-2.1.73-universal',
      'resources', 'claude-code', 'cli.js',
    );
    const fs = require('fs');
    this.cliPath = fs.existsSync(localCli) ? localCli : originalCli;
  }

  getStatus(sessionId: string): ProcessStatus {
    const info = this.processes.get(sessionId);
    if (!info) { return 'not_started'; }
    return info.status;
  }

  /** Get all pending permission requests for a session */
  getPendingPermissions(sessionId: string): PendingPermission[] {
    const info = this.processes.get(sessionId);
    if (!info) { return []; }
    return Array.from(info.pendingPermissions.values());
  }

  /** Respond to a permission request (approve or deny) */
  respondToPermission(sessionId: string, requestId: string, allow: boolean): boolean {
    const info = this.processes.get(sessionId);
    if (!info || !info.pendingPermissions.has(requestId)) { return false; }

    const response = JSON.stringify({
      type: 'control_response',
      response: {
        subtype: allow ? 'success' : 'error',
        request_id: requestId,
        response: allow
          ? { behavior: 'allow', updatedInput: info.pendingPermissions.get(requestId)!.input }
          : null,
        error: allow ? undefined : 'Denied by user via API',
      },
    });

    try {
      info.process.stdin?.write(response + '\n');
      info.pendingPermissions.delete(requestId);

      // Notify SSE clients
      const sseData = `event: permission_resolved\ndata: ${JSON.stringify({ requestId, allowed: allow })}\n\n`;
      for (const client of info.sseClients) {
        client.write(sseData);
      }
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Send a message to a session. Spawns/resumes CLI if needed.
   * Response is streamed via SSE to `res`.
   */
  sendMessage(
    sessionId: string,
    message: string,
    model: string,
    cwd: string,
    res: http.ServerResponse,
  ): void {
    // Set up SSE headers
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });

    let info = this.processes.get(sessionId);

    // If no process or previous one exited, spawn a new one
    if (!info || info.status !== 'running') {
      const isResume = info !== undefined || this.sessionFileExists(sessionId);
      info = this.spawnProcess(sessionId, model, cwd, isResume);
    }

    // Register SSE client
    info.sseClients.add(res);

    // Clean up on client disconnect
    res.on('close', () => {
      info!.sseClients.delete(res);
    });

    // Write message to CLI stdin
    const inputMsg = JSON.stringify({
      type: 'user',
      session_id: '',
      message: { role: 'user', content: [{ type: 'text', text: message }] },
      parent_tool_use_id: null,
    });

    try {
      info.process.stdin?.write(inputMsg + '\n');
    } catch (e: any) {
      res.write(`event: error\ndata: ${JSON.stringify({ error: e.message })}\n\n`);
      res.end();
    }
  }

  /** Subscribe to a session's output stream without sending a message */
  subscribe(sessionId: string, res: http.ServerResponse): boolean {
    const info = this.processes.get(sessionId);
    if (!info) { return false; }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });

    info.sseClients.add(res);
    res.on('close', () => { info.sseClients.delete(res); });

    // Send current pending permissions as initial events
    for (const perm of info.pendingPermissions.values()) {
      res.write(`event: permission_request\ndata: ${JSON.stringify(perm)}\n\n`);
    }

    return true;
  }

  spawnProcess(
    sessionId: string,
    model: string,
    cwd: string,
    isResume: boolean,
  ): ProcessInfo {
    const effectiveModel = this.models.get(sessionId) || model || 'sonnet';

    const args = [
      this.cliPath,
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--model', effectiveModel,
      '--permission-mode', 'acceptEdits',
      '--permission-prompt-tool', 'stdio',
    ];

    if (isResume) {
      args.push('--resume', sessionId);
    }

    const proc = child_process.spawn(process.execPath, args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    const info: ProcessInfo = {
      sessionId,
      process: proc,
      status: 'running',
      model: effectiveModel,
      cwd,
      sseClients: new Set(),
      buffer: '',
      pendingPermissions: new Map(),
    };

    this.processes.set(sessionId, info);

    // Parse stdout line by line
    proc.stdout?.on('data', (chunk: Buffer) => {
      info.buffer += chunk.toString();
      const lines = info.buffer.split('\n');
      info.buffer = lines.pop()!;
      for (const line of lines) {
        if (!line.trim()) { continue; }
        try {
          const parsed = JSON.parse(line);
          this.handleCliMessage(info, parsed);
        } catch {
          const sseData = `data: ${JSON.stringify({ type: 'raw', text: line })}\n\n`;
          for (const client of info.sseClients) {
            client.write(sseData);
          }
        }
      }
    });

    // Collect stderr
    let stderrBuf = '';
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString();
    });

    // Handle exit
    proc.on('exit', (code) => {
      if (code !== 0) {
        info.status = 'error';
        info.lastError = stderrBuf.slice(-1000) || `Exited with code ${code}`;
      } else {
        info.status = 'idle';
      }

      const doneEvent = `event: done\ndata: ${JSON.stringify({ code, error: info.lastError })}\n\n`;
      for (const client of info.sseClients) {
        client.write(doneEvent);
        client.end();
      }
      info.sseClients.clear();
      info.pendingPermissions.clear();
    });

    proc.on('error', (err) => {
      info.status = 'error';
      info.lastError = err.message;

      const errorEvent = `event: error\ndata: ${JSON.stringify({ error: err.message })}\n\n`;
      for (const client of info.sseClients) {
        client.write(errorEvent);
        client.end();
      }
      info.sseClients.clear();
    });

    return info;
  }

  /** Handle a parsed JSON message from CLI stdout */
  private handleCliMessage(info: ProcessInfo, msg: any): void {
    // Detect control_request (permission prompts)
    if (msg.type === 'control_request' && msg.request?.subtype === 'can_use_tool') {
      const perm: PendingPermission = {
        requestId: msg.request_id,
        sessionId: info.sessionId,
        toolName: msg.request.tool_name,
        input: msg.request.input,
        timestamp: Date.now(),
      };
      info.pendingPermissions.set(msg.request_id, perm);

      // Push as SSE event
      const sseData = `event: permission_request\ndata: ${JSON.stringify(perm)}\n\n`;
      for (const client of info.sseClients) {
        client.write(sseData);
      }
      return;
    }

    // Forward all other messages as regular SSE data
    const sseData = `data: ${JSON.stringify(msg)}\n\n`;
    for (const client of info.sseClients) {
      client.write(sseData);
    }
  }

  stopProcess(sessionId: string): boolean {
    const info = this.processes.get(sessionId);
    if (!info || info.status !== 'running') { return false; }
    info.process.kill('SIGTERM');
    info.status = 'idle';
    return true;
  }

  setModel(sessionId: string, model: string): void {
    this.models.set(sessionId, model);
    const info = this.processes.get(sessionId);
    if (info && info.status === 'running') {
      info.model = model;
    }
  }

  getModel(sessionId: string): string | undefined {
    return this.models.get(sessionId);
  }

  /** Interrupt the CLI (send SIGINT, not SIGTERM — allows graceful stop) */
  interruptProcess(sessionId: string): boolean {
    const info = this.processes.get(sessionId);
    if (!info || info.status !== 'running') { return false; }
    info.process.kill('SIGINT');
    return true;
  }

  private sessionFileExists(sessionId: string): boolean {
    const fs = require('fs');
    const os = require('os');
    const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
    const projectsDir = path.join(configDir, 'projects');
    if (!fs.existsSync(projectsDir)) { return false; }
    const dirs = fs.readdirSync(projectsDir, { withFileTypes: true }).filter((d: any) => d.isDirectory());
    for (const dir of dirs) {
      if (fs.existsSync(path.join(projectsDir, dir.name, `${sessionId}.jsonl`))) {
        return true;
      }
    }
    return false;
  }

  dispose(): void {
    for (const [, info] of this.processes) {
      if (info.status === 'running') {
        info.process.kill('SIGTERM');
      }
      for (const client of info.sseClients) {
        client.end();
      }
    }
    this.processes.clear();
  }
}