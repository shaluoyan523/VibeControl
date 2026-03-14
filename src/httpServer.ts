import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { SessionManager } from './sessionManager';
import { ProcessManager } from './processManager';

/** API-created session that hasn't been used with CLI yet */
interface PendingSession {
  id: string;
  name: string;
  projectPath: string;
  model: string;
  createdAt: number;
}

export class HttpServer {
  private server: http.Server | null = null;
  private actualPort: number = 0;
  private portFilePath: string;
  /** Sessions created via API that don't yet have a CLI-generated .jsonl */
  private pendingSessions = new Map<string, PendingSession>();

  constructor(
    private sessionManager: SessionManager,
    private processManager: ProcessManager,
    private port: number,
  ) {
    const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
    this.portFilePath = path.join(configDir, 'vibe-control-port');
  }

  async start(): Promise<number> {
    return new Promise((resolve, reject) => {
      let attempts = 0;
      const tryListen = (port: number) => {
        const srv = http.createServer((req, res) => this.handleRequest(req, res));
        srv.on('error', (err: any) => {
          if (err.code === 'EADDRINUSE' && attempts < 3) {
            attempts++;
            tryListen(port + 1);
          } else {
            reject(err);
          }
        });
        srv.listen(port, '127.0.0.1', () => {
          this.server = srv;
          this.actualPort = port;
          try {
            const dir = path.dirname(this.portFilePath);
            if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }
            fs.writeFileSync(this.portFilePath, String(port));
          } catch { /* ignore */ }
          resolve(port);
        });
      };
      tryListen(this.port);
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      try { fs.unlinkSync(this.portFilePath); } catch { /* ignore */ }
      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders());
      res.end();
      return;
    }

    try {
      const url = new URL(req.url || '/', `http://localhost`);
      const segments = url.pathname.split('/').filter(Boolean);

      if (segments[0] !== 'api' || segments[1] !== 'conversations') {
        sendJson(res, 404, { error: 'Not found' });
        return;
      }

      const method = req.method || 'GET';
      const id = segments[2];
      const action = segments[3];

      // GET /api/conversations
      if (method === 'GET' && segments.length === 2) {
        return this.handleList(url, res);
      }

      // POST /api/conversations
      if (method === 'POST' && segments.length === 2) {
        return await this.handleCreate(req, res);
      }

      if (!id) {
        sendJson(res, 400, { error: 'Missing conversation ID' });
        return;
      }

      // GET /api/conversations/:id
      if (method === 'GET' && !action) {
        return this.handleGet(id, res);
      }

      // DELETE /api/conversations/:id
      if (method === 'DELETE' && !action) {
        return this.handleDelete(id, res);
      }

      // GET /api/conversations/:id/status
      if (method === 'GET' && action === 'status') {
        return this.handleStatus(id, res);
      }

      // GET /api/conversations/:id/stream
      if (method === 'GET' && action === 'stream') {
        return this.handleStream(id, res);
      }

      // GET /api/conversations/:id/permissions
      if (method === 'GET' && action === 'permissions') {
        return this.handleListPermissions(id, res);
      }

      // POST actions
      if (method === 'POST' && action) {
        const body = await readBody(req);
        const data = body ? JSON.parse(body) : {};

        switch (action) {
          case 'rename':
            return this.handleRename(id, data, res);
          case 'message':
            return this.handleMessage(id, data, res);
          case 'stop':
            return this.handleStop(id, res);
          case 'model':
            return this.handleModel(id, data, res);
          case 'permission':
            return this.handlePermissionResponse(id, data, res);
          case 'interrupt':
            return this.handleInterrupt(id, res);
          default:
            sendJson(res, 404, { error: `Unknown action: ${action}` });
            return;
        }
      }

      sendJson(res, 404, { error: 'Not found' });
    } catch (e: any) {
      sendJson(res, 500, { error: e.message });
    }
  }

  /** GET /api/conversations?projectPath=... */
  private handleList(url: URL, res: http.ServerResponse): void {
    const projectPath = url.searchParams.get('projectPath');
    const groups = this.sessionManager.getProjectGroups();
    let sessions = groups.flatMap(g => g.sessions);

    if (projectPath) {
      sessions = sessions.filter(s => s.cwd === projectPath);
    }

    const result = sessions.map(s => ({
      id: s.sessionId,
      name: s.customTitle || s.summary,
      projectPath: s.cwd,
      lastModified: s.lastModified,
      fileSize: s.fileSize,
      gitBranch: s.gitBranch,
      status: this.processManager.getStatus(s.sessionId),
    }));

    // Include pending API-created sessions that haven't been used yet
    for (const [, pending] of this.pendingSessions) {
      if (projectPath && pending.projectPath !== projectPath) { continue; }
      // Skip if a real session with this ID already exists (CLI created it)
      if (result.some(r => r.id === pending.id)) { continue; }
      result.push({
        id: pending.id,
        name: pending.name,
        projectPath: pending.projectPath,
        lastModified: pending.createdAt,
        fileSize: 0,
        gitBranch: undefined as any,
        status: this.processManager.getStatus(pending.id),
      });
    }

    sendJson(res, 200, result);
  }

  /** GET /api/conversations/:id */
  private handleGet(id: string, res: http.ServerResponse): void {
    // Check pending sessions first
    const pending = this.pendingSessions.get(id);
    if (pending) {
      sendJson(res, 200, {
        id: pending.id,
        name: pending.name,
        projectPath: pending.projectPath,
        model: pending.model,
        lastModified: pending.createdAt,
        status: this.processManager.getStatus(id),
        messages: [],
      });
      return;
    }

    const session = this.sessionManager.getSession(id);
    if (!session) {
      sendJson(res, 404, { error: 'Conversation not found' });
      return;
    }

    const messages = this.sessionManager.getConversationMessages(id);
    sendJson(res, 200, {
      id: session.sessionId,
      name: session.customTitle || session.summary,
      projectPath: session.cwd,
      lastModified: session.lastModified,
      fileSize: session.fileSize,
      gitBranch: session.gitBranch,
      status: this.processManager.getStatus(id),
      messages,
    });
  }

  /**
   * POST /api/conversations {name, projectPath, model}
   *
   * Does NOT create a .jsonl file — that's the CLI's job.
   * We store metadata in-memory until the first message triggers the CLI.
   */
  private async handleCreate(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await readBody(req);
    const data = JSON.parse(body);
    const { name, projectPath, model } = data;

    if (!projectPath) {
      sendJson(res, 400, { error: 'projectPath is required' });
      return;
    }

    const sessionId = crypto.randomUUID();

    // Store in-memory only — no .jsonl created
    this.pendingSessions.set(sessionId, {
      id: sessionId,
      name: name || sessionId.slice(0, 8),
      projectPath,
      model: model || 'sonnet',
      createdAt: Date.now(),
    });

    if (model) {
      this.processManager.setModel(sessionId, model);
    }

    sendJson(res, 201, {
      id: sessionId,
      name: name || sessionId.slice(0, 8),
      projectPath,
      model: model || 'sonnet',
      status: 'not_started',
    });
  }

  /** DELETE /api/conversations/:id */
  private handleDelete(id: string, res: http.ServerResponse): void {
    // Remove from pending if it was API-created
    this.pendingSessions.delete(id);

    this.processManager.stopProcess(id);
    if (this.sessionManager.deleteSession(id)) {
      this.sessionManager.refresh();
      sendJson(res, 200, { success: true });
    } else {
      // Even if no .jsonl existed, the pending session was removed
      sendJson(res, 200, { success: true });
    }
  }

  /** POST /api/conversations/:id/rename {name} */
  private handleRename(id: string, data: any, res: http.ServerResponse): void {
    const { name } = data;
    if (!name) {
      sendJson(res, 400, { error: 'name is required' });
      return;
    }

    // Update pending session name if it's API-created
    const pending = this.pendingSessions.get(id);
    if (pending) {
      pending.name = name;
      sendJson(res, 200, { success: true });
      return;
    }

    // Try renaming the real session .jsonl
    // Also try renaming via CLI sessionId if there's a mapping
    const cliId = this.processManager.getCliSessionId(id);
    const renamed = this.sessionManager.renameSession(id, name)
      || (cliId ? this.sessionManager.renameSession(cliId, name) : false);

    if (renamed) {
      this.sessionManager.refresh();
      sendJson(res, 200, { success: true });
    } else {
      sendJson(res, 404, { error: 'Conversation not found' });
    }
  }

  /** POST /api/conversations/:id/message {message} → SSE stream */
  private handleMessage(id: string, data: any, res: http.ServerResponse): void {
    const { message } = data;
    if (!message) {
      sendJson(res, 400, { error: 'message is required' });
      return;
    }

    // Determine cwd: from pending session, real session, or fallback
    const pending = this.pendingSessions.get(id);
    const session = this.sessionManager.getSession(id);
    const cwd = pending?.projectPath || session?.cwd || process.cwd();
    const model = this.processManager.getModel(id) || pending?.model || 'sonnet';

    // Once the first message is sent, promote from pending to active
    if (pending) {
      // Apply the custom name after CLI creates its session
      const pendingName = pending.name;
      // Keep a reference so we can apply the title later
      const checkAndApplyTitle = () => {
        const cliId = this.processManager.getCliSessionId(id);
        if (cliId && pendingName) {
          this.sessionManager.renameSession(cliId, pendingName);
          this.sessionManager.refresh();
          this.pendingSessions.delete(id);
          return true;
        }
        return false;
      };

      // Poll briefly for CLI to report its sessionId
      let attempts = 0;
      const interval = setInterval(() => {
        attempts++;
        if (checkAndApplyTitle() || attempts > 30) {
          clearInterval(interval);
        }
      }, 500);
    }

    this.processManager.sendMessage(id, message, model, cwd, res);
  }

  /** POST /api/conversations/:id/stop */
  private handleStop(id: string, res: http.ServerResponse): void {
    if (this.processManager.stopProcess(id)) {
      sendJson(res, 200, { success: true });
    } else {
      sendJson(res, 404, { error: 'No running process for this conversation' });
    }
  }

  /** GET /api/conversations/:id/status */
  private handleStatus(id: string, res: http.ServerResponse): void {
    sendJson(res, 200, { status: this.processManager.getStatus(id) });
  }

  /** POST /api/conversations/:id/model {model} */
  private handleModel(id: string, data: any, res: http.ServerResponse): void {
    const { model } = data;
    if (!model) {
      sendJson(res, 400, { error: 'model is required' });
      return;
    }
    this.processManager.setModel(id, model);

    // Also update pending session
    const pending = this.pendingSessions.get(id);
    if (pending) { pending.model = model; }

    sendJson(res, 200, { success: true, model });
  }

  /** GET /api/conversations/:id/stream — subscribe to SSE output */
  private handleStream(id: string, res: http.ServerResponse): void {
    if (!this.processManager.subscribe(id, res)) {
      sendJson(res, 404, { error: 'No active process for this conversation' });
    }
  }

  /** GET /api/conversations/:id/permissions */
  private handleListPermissions(id: string, res: http.ServerResponse): void {
    const perms = this.processManager.getPendingPermissions(id);
    sendJson(res, 200, { permissions: perms });
  }

  /** POST /api/conversations/:id/permission {requestId, allow} */
  private handlePermissionResponse(id: string, data: any, res: http.ServerResponse): void {
    const { requestId, allow } = data;
    if (!requestId || allow === undefined) {
      sendJson(res, 400, { error: 'requestId and allow are required' });
      return;
    }
    if (this.processManager.respondToPermission(id, requestId, !!allow)) {
      sendJson(res, 200, { success: true });
    } else {
      sendJson(res, 404, { error: 'Permission request not found' });
    }
  }

  /** POST /api/conversations/:id/interrupt */
  private handleInterrupt(id: string, res: http.ServerResponse): void {
    if (this.processManager.interruptProcess(id)) {
      sendJson(res, 200, { success: true });
    } else {
      sendJson(res, 404, { error: 'No running process for this conversation' });
    }
  }

  dispose(): void {
    this.stop();
  }
}

function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function sendJson(res: http.ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(data));
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}
