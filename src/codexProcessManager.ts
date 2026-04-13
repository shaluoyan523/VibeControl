import * as child_process from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import { resolveCodexExecutable } from './codexCli';
import { getCodexSessionsDir } from './runtimePaths';
import type { PendingPermission, ProcessStatus } from './processManager';
import { buildSessionToolEnvironment } from './sessionTooling';

interface ProcessInfo {
  sessionId: string;
  resolvedSessionId?: string;
  process: child_process.ChildProcess;
  status: 'running' | 'idle' | 'error';
  model?: string;
  cwd: string;
  lastError?: string;
  sseClients: Set<http.ServerResponse>;
  buffer: string;
}

export class CodexProcessManager {
  private readonly processes = new Map<string, ProcessInfo>();
  private readonly models = new Map<string, string>();
  /** Maps API-facing alias -> Codex's real thread ID. */
  private readonly resolvedSessionMap = new Map<string, string>();
  private readonly sessionsDir = getCodexSessionsDir();
  private readonly codexExecutable = resolveCodexExecutable();

  getStatus(sessionId: string): ProcessStatus {
    const info = this.processes.get(this.resolveProcessKey(sessionId));
    if (!info) { return 'not_started'; }
    if (info.status !== 'running') {
      return 'not_started';
    }
    return 'running';
  }

  getResolvedSessionId(sessionId: string): string | undefined {
    return this.resolvedSessionMap.get(this.resolveProcessKey(sessionId));
  }

  getPendingPermissions(_sessionId: string): PendingPermission[] {
    return [];
  }

  respondToPermission(_sessionId: string, _requestId: string, _allow: boolean): boolean {
    return false;
  }

  sendMessage(
    sessionId: string,
    message: string,
    model: string | undefined,
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
    const existing = this.processes.get(processKey);
    if (existing && existing.status === 'running') {
      res.write(`event: error\ndata: ${JSON.stringify({ error: 'Conversation is already running' })}\n\n`);
      res.write(`event: done\ndata: ${JSON.stringify({ code: -1, error: 'Conversation is already running' })}\n\n`);
      res.end();
      return;
    }

    if (existing) {
      this.processes.delete(processKey);
    }

    const resolvedId = this.resolvedSessionMap.get(processKey);
    const isResume = !!resolvedId || this.realSessionFileExists(processKey);
    const resumeId = resolvedId || processKey;

    let info: ProcessInfo;
    try {
      info = this.spawnProcess(processKey, model, cwd, message, isResume, resumeId);
    } catch (error: any) {
      res.write(`event: error\ndata: ${JSON.stringify({ error: `Failed to spawn: ${error.message}` })}\n\n`);
      res.write(`event: done\ndata: ${JSON.stringify({ code: -1, error: error.message })}\n\n`);
      res.end();
      return;
    }

    info.sseClients.add(res);
    res.on('close', () => {
      info.sseClients.delete(res);
    });
  }

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
    res.on('close', () => {
      info.sseClients.delete(res);
    });
    return true;
  }

  stopProcess(sessionId: string): boolean {
    const info = this.processes.get(this.resolveProcessKey(sessionId));
    if (!info || info.status !== 'running') { return false; }
    info.process.kill('SIGTERM');
    info.status = 'idle';
    return true;
  }

  interruptProcess(sessionId: string): boolean {
    const info = this.processes.get(this.resolveProcessKey(sessionId));
    if (!info || info.status !== 'running') { return false; }
    info.process.kill('SIGINT');
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

  clearSession(sessionId: string): void {
    const processKey = this.resolveProcessKey(sessionId);
    this.processes.delete(processKey);
    this.models.delete(processKey);
    this.resolvedSessionMap.delete(processKey);
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

  private spawnProcess(
    sessionId: string,
    model: string | undefined,
    cwd: string,
    message: string,
    isResume: boolean,
    resumeId?: string,
  ): ProcessInfo {
    const effectiveModel = this.models.get(sessionId) || model;
    const args = isResume
      ? this.buildResumeArgs(resumeId || sessionId, effectiveModel, message)
      : this.buildNewArgs(cwd, effectiveModel, message);

    const proc = child_process.spawn(this.codexExecutable, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...buildSessionToolEnvironment({
          provider: 'codex',
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
    };

    this.processes.set(sessionId, info);

    proc.stdout?.on('data', (chunk: Buffer) => {
      info.buffer += chunk.toString();
      const lines = info.buffer.split('\n');
      info.buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) { continue; }
        try {
          this.handleCodexMessage(info, JSON.parse(line));
        } catch {
          this.broadcast(info, `data: ${JSON.stringify({ type: 'raw', text: line })}\n\n`);
        }
      }
    });

    let stderrBuffer = '';
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderrBuffer += chunk.toString();
    });

    proc.on('exit', (code) => {
      if (code !== 0) {
        info.status = 'error';
        info.lastError = stderrBuffer.slice(-1000) || `Exited with code ${code}`;
      } else {
        info.status = 'idle';
      }

      this.broadcast(info, `event: done\ndata: ${JSON.stringify({ code, error: info.lastError })}\n\n`, true);
      info.sseClients.clear();
    });

    proc.on('error', (error) => {
      info.status = 'error';
      info.lastError = error.message;
      this.broadcast(info, `event: error\ndata: ${JSON.stringify({ error: error.message })}\n\n`);
      this.broadcast(info, `event: done\ndata: ${JSON.stringify({ code: -1, error: error.message })}\n\n`, true);
      info.sseClients.clear();
    });

    return info;
  }

  private buildNewArgs(cwd: string, model: string | undefined, message: string): string[] {
    const args = [
      'exec',
      '--json',
      '--skip-git-repo-check',
      '-C',
      cwd,
      '--sandbox',
      'workspace-write',
    ];
    if (model) {
      args.push('-m', model);
    }
    args.push('--', message);
    return args;
  }

  private buildResumeArgs(resumeId: string, model: string | undefined, message: string): string[] {
    const args = [
      'exec',
      'resume',
      '--json',
      '--skip-git-repo-check',
    ];
    if (model) {
      args.push('-m', model);
    }
    args.push('--', resumeId, message);
    return args;
  }

  private handleCodexMessage(info: ProcessInfo, message: any): void {
    const resolvedSessionId = this.extractResolvedSessionId(message);
    if (resolvedSessionId && !info.resolvedSessionId) {
      info.resolvedSessionId = resolvedSessionId;
      this.resolvedSessionMap.set(info.sessionId, resolvedSessionId);
      this.broadcast(
        info,
        `event: session_resolved\ndata: ${JSON.stringify({ id: info.sessionId, resolvedId: resolvedSessionId })}\n\n`,
      );
    }

    this.broadcast(info, `data: ${JSON.stringify(message)}\n\n`);
  }

  private extractResolvedSessionId(message: any): string | undefined {
    const threadId = message?.thread_id;
    if (typeof threadId === 'string' && threadId) {
      return threadId;
    }
    return undefined;
  }

  private resolveProcessKey(sessionId: string): string {
    if (this.processes.has(sessionId) || this.models.has(sessionId) || this.resolvedSessionMap.has(sessionId)) {
      return sessionId;
    }

    for (const [apiSessionId, resolvedSessionId] of this.resolvedSessionMap) {
      if (resolvedSessionId === sessionId) {
        return apiSessionId;
      }
    }

    return sessionId;
  }

  private realSessionFileExists(sessionId: string): boolean {
    return !!this.findSessionFile(sessionId);
  }

  private findSessionFile(sessionId: string): string | null {
    if (!fs.existsSync(this.sessionsDir)) { return null; }
    const files = this.collectJsonlFiles(this.sessionsDir);
    for (const filePath of files) {
      if (filePath.includes(sessionId)) {
        return filePath;
      }
    }
    return null;
  }

  private collectJsonlFiles(dir: string): string[] {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const files: string[] = [];

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...this.collectJsonlFiles(fullPath));
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        files.push(fullPath);
      }
    }

    return files;
  }

  private broadcast(info: ProcessInfo, payload: string, end = false): void {
    for (const client of info.sseClients) {
      client.write(payload);
      if (end) {
        client.end();
      }
    }
  }
}
