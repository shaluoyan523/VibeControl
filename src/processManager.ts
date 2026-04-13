import * as child_process from 'child_process';
import * as path from 'path';
import * as http from 'http';
import { resolveClaudeCliScript } from './claudeCli';
import { getClaudeProjectsDir } from './runtimePaths';
import { buildSessionToolEnvironment } from './sessionTooling';

export type ProcessStatus = 'running' | 'idle' | 'error' | 'not_started';

export interface PendingPermission {
  requestId: string;
  sessionId: string;
  toolName: string;
  input: any;
  timestamp: number;
}

interface ProcessInfo {
  sessionId: string;       // API-facing session ID (may differ from CLI's)
  cliSessionId?: string;   // Real session ID assigned by the CLI
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
  /** Maps API sessionId → CLI's real sessionId (populated after first message) */
  private cliSessionMap = new Map<string, string>();

  constructor(extensionPath: string) {
    this.cliPath = resolveClaudeCliScript(extensionPath);
  }

  getStatus(sessionId: string): ProcessStatus {
    const info = this.processes.get(this.resolveProcessKey(sessionId));
    if (!info) { return 'not_started'; }
    // Don't persist error/idle status from dead processes — treat them as not_started
    if (info.status !== 'running') {
      return 'not_started';
    }
    return 'running';
  }

  /** Get the CLI's real session ID for an API session ID (if known) */
  getCliSessionId(apiSessionId: string): string | undefined {
    return this.cliSessionMap.get(this.resolveProcessKey(apiSessionId));
  }

  getResolvedSessionId(sessionId: string): string | undefined {
    return this.getCliSessionId(sessionId);
  }

  /** Get all pending permission requests for a session */
  getPendingPermissions(sessionId: string): PendingPermission[] {
    const info = this.processes.get(this.resolveProcessKey(sessionId));
    if (!info) { return []; }
    return Array.from(info.pendingPermissions.values());
  }

  /** Respond to a permission request (approve or deny) */
  respondToPermission(sessionId: string, requestId: string, allow: boolean): boolean {
    const info = this.processes.get(this.resolveProcessKey(sessionId));
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
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });

    const processKey = this.resolveProcessKey(sessionId);
    let info = this.processes.get(processKey);

    // If no process or previous one exited/errored, clean up and spawn fresh
    if (!info || info.status !== 'running') {
      if (info) {
        // Clean up stale error state — don't let old errors block new attempts
        this.processes.delete(processKey);
      }
      const cliId = this.cliSessionMap.get(processKey);
      const isResume = !!cliId || this.realSessionFileExists(processKey);
      const resumeId = cliId || processKey;
      try {
        info = this.spawnProcess(processKey, model, cwd, isResume, resumeId);
      } catch (e: any) {
        res.write(`event: error\ndata: ${JSON.stringify({ error: `Failed to spawn: ${e.message}` })}\n\n`);
        res.write(`event: done\ndata: ${JSON.stringify({ code: -1, error: e.message })}\n\n`);
        res.end();
        return;
      }
    }

    info.sseClients.add(res);
    res.on('close', () => { info!.sseClients.delete(res); });

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
    const info = this.processes.get(this.resolveProcessKey(sessionId));
    if (!info) { return false; }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });

    info.sseClients.add(res);
    res.on('close', () => { info.sseClients.delete(res); });

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
    resumeId?: string,
  ): ProcessInfo {
    const effectiveModel = this.models.get(sessionId) || model || 'sonnet';

    const args = [
      this.cliPath,
      '--print',
      '--verbose',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--model', effectiveModel,
      '--permission-mode', 'acceptEdits',
      '--permission-prompt-tool', 'stdio',
    ];

    if (isResume && resumeId) {
      args.push('--resume', resumeId);
    }

    const proc = child_process.spawn(process.execPath, args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...buildSessionToolEnvironment({
          provider: 'claude',
          sessionId,
          cwd,
        }),
      },
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

    let stderrBuf = '';
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString();
    });

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
    // Capture CLI's real session ID from any message that contains it
    if (msg.session_id && !info.cliSessionId) {
      info.cliSessionId = msg.session_id;
      this.cliSessionMap.set(info.sessionId, msg.session_id);
    }

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
    const info = this.processes.get(this.resolveProcessKey(sessionId));
    if (!info || info.status !== 'running') { return false; }
    info.process.kill('SIGTERM');
    info.status = 'idle';
    return true;
  }

  setModel(sessionId: string, model: string): void {
    const processKey = this.resolveProcessKey(sessionId);
    this.models.set(processKey, model);
    const info = this.processes.get(processKey);
    if (info && info.status === 'running') {
      info.model = model;
    }
  }

  getModel(sessionId: string): string | undefined {
    return this.models.get(this.resolveProcessKey(sessionId));
  }

  /** Interrupt the CLI (send SIGINT, not SIGTERM — allows graceful stop) */
  interruptProcess(sessionId: string): boolean {
    const info = this.processes.get(this.resolveProcessKey(sessionId));
    if (!info || info.status !== 'running') { return false; }
    info.process.kill('SIGINT');
    return true;
  }

  clearSession(sessionId: string): void {
    const processKey = this.resolveProcessKey(sessionId);
    this.processes.delete(processKey);
    this.models.delete(processKey);
    this.cliSessionMap.delete(processKey);
  }

  /**
   * Check if a REAL session .jsonl file exists (one created by the CLI, with actual messages).
   * This excludes files we might have pre-created via the API.
   */
  private realSessionFileExists(sessionId: string): boolean {
    const fs = require('fs');
    const projectsDir = getClaudeProjectsDir();
    if (!fs.existsSync(projectsDir)) { return false; }
    const dirs = fs.readdirSync(projectsDir, { withFileTypes: true }).filter((d: any) => d.isDirectory());
    for (const dir of dirs) {
      const filePath = path.join(projectsDir, dir.name, `${sessionId}.jsonl`);
      if (fs.existsSync(filePath)) {
        // Check if the file has actual user messages (not just our API-created stub)
        const content = fs.readFileSync(filePath, 'utf-8');
        if (content.includes('"type":"user"') || content.includes('"type": "user"')) {
          return true;
        }
        return false;
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

  private resolveProcessKey(sessionId: string): string {
    if (this.processes.has(sessionId) || this.models.has(sessionId) || this.cliSessionMap.has(sessionId)) {
      return sessionId;
    }

    for (const [apiSessionId, cliSessionId] of this.cliSessionMap) {
      if (cliSessionId === sessionId) {
        return apiSessionId;
      }
    }

    return sessionId;
  }
}
