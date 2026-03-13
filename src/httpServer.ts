import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { SessionManager } from './sessionManager';
import { ProcessManager } from './processManager';

export class HttpServer {
  private server: http.Server | null = null;
  private actualPort: number = 0;
  private portFilePath: string;

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
          // Write port file for discovery
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
      // Clean up port file
      try { fs.unlinkSync(this.portFilePath); } catch { /* ignore */ }
      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // CORS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders());
      res.end();
      return;
    }

    try {
      const url = new URL(req.url || '/', `http://localhost`);
      const segments = url.pathname.split('/').filter(Boolean);
      // segments: ['api', 'conversations', ':id', 'action']

      if (segments[0] !== 'api' || segments[1] !== 'conversations') {
        sendJson(res, 404, { error: 'Not found' });
        return;
      }

      const method = req.method || 'GET';
      const id = segments[2]; // conversation ID (may be undefined)
      const action = segments[3]; // sub-action (may be undefined)

      // GET /api/conversations
      if (method === 'GET' && segments.length === 2) {
        return this.handleList(url, res);
      }

      // POST /api/conversations
      if (method === 'POST' && segments.length === 2) {
        return await this.handleCreate(req, res);
      }

      // Need an ID for all remaining routes
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

      // GET /api/conversations/:id/stream — subscribe to SSE without sending a message
      if (method === 'GET' && action === 'stream') {
        return this.handleStream(id, res);
      }

      // GET /api/conversations/:id/permissions — list pending permissions
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

    sendJson(res, 200, sessions.map(s => ({
      id: s.sessionId,
      name: s.customTitle || s.summary,
      projectPath: s.cwd,
      lastModified: s.lastModified,
      fileSize: s.fileSize,
      gitBranch: s.gitBranch,
      status: this.processManager.getStatus(s.sessionId),
    })));
  }

  /** GET /api/conversations/:id */
  private handleGet(id: string, res: http.ServerResponse): void {
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

  /** POST /api/conversations {name, projectPath, model} */
  private async handleCreate(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await readBody(req);
    const data = JSON.parse(body);
    const { name, projectPath, model } = data;

    if (!projectPath) {
      sendJson(res, 400, { error: 'projectPath is required' });
      return;
    }

    const sessionId = crypto.randomUUID();

    // Create the session .jsonl file in the correct project directory
    const dirName = this.pathToDirName(projectPath);
    const projectDir = path.join(this.sessionManager.projectsDir, dirName);
    if (!fs.existsSync(projectDir)) {
      fs.mkdirSync(projectDir, { recursive: true });
    }

    const filePath = path.join(projectDir, `${sessionId}.jsonl`);
    const initLine = JSON.stringify({
      type: 'queue-operation',
      sessionId,
    });
    fs.writeFileSync(filePath, initLine + '\n');

    // Write custom title if name provided
    if (name) {
      this.sessionManager.renameSession(sessionId, name);
    }

    // Store model preference
    if (model) {
      this.processManager.setModel(sessionId, model);
    }

    this.sessionManager.refresh();

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
    this.processManager.stopProcess(id);
    if (this.sessionManager.deleteSession(id)) {
      this.sessionManager.refresh();
      sendJson(res, 200, { success: true });
    } else {
      sendJson(res, 404, { error: 'Conversation not found' });
    }
  }

  /** POST /api/conversations/:id/rename {name} */
  private handleRename(id: string, data: any, res: http.ServerResponse): void {
    const { name } = data;
    if (!name) {
      sendJson(res, 400, { error: 'name is required' });
      return;
    }
    if (this.sessionManager.renameSession(id, name)) {
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

    // Look up session for cwd
    const session = this.sessionManager.getSession(id);
    const cwd = session?.cwd || process.cwd();
    const model = this.processManager.getModel(id) || 'sonnet';

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
    sendJson(res, 200, { success: true, model });
  }

  /** GET /api/conversations/:id/stream — subscribe to SSE output */
  private handleStream(id: string, res: http.ServerResponse): void {
    if (!this.processManager.subscribe(id, res)) {
      sendJson(res, 404, { error: 'No active process for this conversation' });
    }
  }

  /** GET /api/conversations/:id/permissions — list pending permission requests */
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

  /** POST /api/conversations/:id/interrupt — send SIGINT */
  private handleInterrupt(id: string, res: http.ServerResponse): void {
    if (this.processManager.interruptProcess(id)) {
      sendJson(res, 200, { success: true });
    } else {
      sendJson(res, 404, { error: 'No running process for this conversation' });
    }
  }

  /** Convert an absolute path to Claude's project directory name format */
  private pathToDirName(absPath: string): string {
    // Claude Code uses: path.replace(/\//g, '-').replace(/^-/, '')... but actually
    // the directory names look like: -home-dataset-local-data1-vibe-control
    // which is just the path with / replaced by - (keeping leading -)
    return absPath.replace(/\//g, '-');
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