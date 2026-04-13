import * as crypto from 'crypto';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import { CodexProcessManager } from './codexProcessManager';
import { HttpConversationRegistry } from './httpRuntime';
import { PendingPermission, ProcessManager, ProcessStatus } from './processManager';
import { getClaudeConfigDir } from './runtimePaths';
import { CreateSessionHandoffInput, SessionHandoffService } from './sessionHandoffService';
import { SseCaptureResponse } from './sseCaptureResponse';
import { ConversationRecord, ProviderId } from './types';

type ApiProviderId = ProviderId;
type ApiListProvider = ApiProviderId | 'all';

const CREATE_BOOTSTRAP_PROMPTS: Record<ApiProviderId, string> = {
  claude: 'Reply with the current working directory and model for this new session.',
  codex: 'Which model are you using? What path are you bound to?',
};

interface PendingSession {
  provider: ApiProviderId;
  id: string;
  name: string;
  projectPath: string;
  model?: string;
  createdAt: number;
}

interface RuntimeManager {
  clearSession(sessionId: string): void;
  getModel(sessionId: string): string | undefined;
  getPendingPermissions(sessionId: string): PendingPermission[];
  getResolvedSessionId(sessionId: string): string | undefined;
  getStatus(sessionId: string): ProcessStatus;
  interruptProcess(sessionId: string): boolean;
  respondToPermission(sessionId: string, requestId: string, allow: boolean): boolean;
  sendMessage(
    sessionId: string,
    message: string,
    model: string | undefined,
    cwd: string,
    res: http.ServerResponse,
  ): void;
  setModel(sessionId: string, model: string): void;
  stopProcess(sessionId: string): boolean;
  subscribe(sessionId: string, res: http.ServerResponse): boolean;
}

interface ResolvedConversation {
  conversation: ConversationRecord;
  resolvedId?: string;
}

interface BootstrapOutcome {
  error?: string;
  resolvedId?: string;
}

export class HttpServer {
  private server: http.Server | null = null;
  private actualPort = 0;
  private portFilePath: string;
  private pendingSessions = new Map<string, PendingSession>();
  private readonly sessionHandoffService: SessionHandoffService;

  constructor(
    private conversationManager: HttpConversationRegistry,
    private claudeProcessManager: ProcessManager,
    private codexProcessManager: CodexProcessManager,
    private port: number,
    private healthInfo: Record<string, unknown> = {},
  ) {
    const configDir = getClaudeConfigDir();
    this.portFilePath = path.join(configDir, 'vibe-control-port');
    this.sessionHandoffService = new SessionHandoffService(
      this.conversationManager,
      this.claudeProcessManager,
      this.codexProcessManager,
    );
  }

  async start(): Promise<number> {
    return new Promise((resolve, reject) => {
      let attempts = 0;
      const tryListen = (port: number) => {
        const srv = http.createServer((req, res) => this.handleRequest(req, res));
        srv.on('error', (error: any) => {
          if (error.code === 'EADDRINUSE' && attempts < 3) {
            attempts++;
            tryListen(port + 1);
          } else {
            reject(error);
          }
        });
        srv.listen(port, '127.0.0.1', () => {
          this.server = srv;
          this.actualPort = port;
          try {
            const dir = path.dirname(this.portFilePath);
            if (!fs.existsSync(dir)) {
              fs.mkdirSync(dir, { recursive: true });
            }
            fs.writeFileSync(this.portFilePath, String(port));
          } catch {
            // Best-effort port advertisement only.
          }
          resolve(port);
        });
      };
      tryListen(this.port);
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      try {
        fs.unlinkSync(this.portFilePath);
      } catch {
        // Ignore cleanup failures.
      }
      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }

  dispose(): void {
    this.stop();
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders());
      res.end();
      return;
    }

    try {
      const url = new URL(req.url || '/', 'http://localhost');
      const segments = url.pathname.split('/').filter(Boolean);

      if (req.method === 'GET' && url.pathname === '/healthz') {
        sendJson(res, 200, { ok: true, port: this.actualPort, ...this.healthInfo });
        return;
      }

      if (segments[0] !== 'api' || segments[1] !== 'conversations') {
        sendJson(res, 404, { error: 'Not found' });
        return;
      }

      const method = req.method || 'GET';
      const id = segments[2];
      const action = segments[3];

      if (method === 'GET' && segments.length === 2) {
        this.handleList(url, res);
        return;
      }

      if (method === 'POST' && segments.length === 2) {
        await this.handleCreate(req, res);
        return;
      }

      if (!id) {
        sendJson(res, 400, { error: 'Missing conversation ID' });
        return;
      }

      if (method === 'GET' && !action) {
        this.handleGet(url, id, res);
        return;
      }

      if (method === 'DELETE' && !action) {
        this.handleDelete(url, id, res);
        return;
      }

      if (method === 'GET' && action === 'status') {
        this.handleStatus(url, id, res);
        return;
      }

      if (method === 'GET' && action === 'stream') {
        this.handleStream(url, id, res);
        return;
      }

      if (method === 'GET' && action === 'permissions') {
        this.handleListPermissions(url, id, res);
        return;
      }

      if (method === 'POST' && action) {
        const body = await readBody(req);
        const data = body ? JSON.parse(body) : {};

        switch (action) {
          case 'rename':
            this.handleRename(url, id, data, res);
            return;
          case 'message':
            this.handleMessage(url, id, data, res);
            return;
          case 'stop':
            this.handleStop(url, id, res);
            return;
          case 'model':
            this.handleModel(url, id, data, res);
            return;
          case 'permission':
            this.handlePermissionResponse(url, id, data, res);
            return;
          case 'interrupt':
            this.handleInterrupt(url, id, res);
            return;
          case 'handoff':
            await this.handleHandoff(url, id, data, res);
            return;
          default:
            sendJson(res, 404, { error: `Unknown action: ${action}` });
            return;
        }
      }

      sendJson(res, 404, { error: 'Not found' });
    } catch (error: any) {
      sendJson(res, 500, { error: error.message });
    }
  }

  private handleList(url: URL, res: http.ServerResponse): void {
    const providerParam = url.searchParams.get('provider');
    const provider = this.parseListProvider(providerParam);
    if (!provider) {
      sendJson(res, 400, { error: 'Invalid provider' });
      return;
    }
    const projectPath = this.normalizeProjectPath(url.searchParams.get('projectPath') || undefined);
    const providers = provider === 'all' ? ['claude', 'codex'] as const : [provider];
    const result: Record<string, unknown>[] = [];

    for (const currentProvider of providers) {
      const conversationProvider = this.conversationManager.getProvider(currentProvider);
      if (!conversationProvider) { continue; }

      let conversations = conversationProvider.listConversations();
      if (projectPath) {
        conversations = conversations.filter((conversation) => this.sameProjectPath(conversation.cwd, projectPath));
      }

      const runtime = this.getRuntime(currentProvider);
      result.push(
        ...conversations.map((conversation) => this.serializeConversation(currentProvider, conversation, runtime)),
      );

      for (const pending of this.pendingSessions.values()) {
        if (pending.provider !== currentProvider) { continue; }
        if (projectPath && !this.sameProjectPath(pending.projectPath, projectPath)) { continue; }
        if (result.some((conversation) => conversation.id === pending.id)) { continue; }

        const pendingResponse: Record<string, unknown> = {
          id: pending.id,
          provider: currentProvider,
          name: pending.name,
          projectPath: pending.projectPath,
          lastModified: pending.createdAt,
          fileSize: 0,
          gitBranch: undefined,
          status: runtime.getStatus(pending.id),
        };
        if (pending.model) {
          pendingResponse.model = pending.model;
        }
        result.push(pendingResponse);
      }
    }

    result.sort((left, right) => Number(right.lastModified || 0) - Number(left.lastModified || 0));
    sendJson(res, 200, result);
  }

  private async handleCreate(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await readBody(req);
    const data = body ? JSON.parse(body) : {};
    const provider = this.parseProvider(data.provider) || 'claude';
    if (data.provider && !this.parseProvider(data.provider)) {
      sendJson(res, 400, { error: 'Invalid provider' });
      return;
    }
    const { name, projectPath, model } = data;
    const normalizedProjectPath = this.normalizeProjectPath(projectPath);

    if (!normalizedProjectPath) {
      sendJson(res, 400, { error: 'projectPath is required' });
      return;
    }

    const conversationProvider = this.conversationManager.getProvider(provider);
    if (!conversationProvider) {
      sendJson(res, 404, { error: `Provider not found: ${provider}` });
      return;
    }

    const id = crypto.randomUUID();
    const input = {
      name: name || id.slice(0, 8),
      projectPath: normalizedProjectPath,
      model: model || this.getDefaultModel(provider),
    };

    if (conversationProvider.createConversationAndWait) {
      const conversation = await conversationProvider.createConversationAndWait(input, 45000);
      if (!conversation) {
        sendJson(res, 504, {
          error: 'Timed out waiting for conversation creation',
          provider,
        });
        return;
      }

      conversationProvider.prepareConversationForOpen?.(conversation.id);
      this.conversationManager.refresh();

      const response: Record<string, unknown> = {
        ...this.serializeConversation(provider, conversation, this.getRuntime(provider), conversation.id),
        requestedId: id,
      };
      if (input.model) {
        response.model = input.model;
      }
      sendJson(res, 201, response);
      return;
    }

    const pending: PendingSession = {
      provider,
      id,
      name: input.name,
      projectPath: normalizedProjectPath,
      model: input.model,
      createdAt: Date.now(),
    };

    this.pendingSessions.set(this.pendingKey(provider, id), pending);
    if (pending.model) {
      this.getRuntime(provider).setModel(id, pending.model);
    }

    const bootstrapMessage = this.getCreateBootstrapMessage(provider);
    const bootstrap = await this.bootstrapPendingSession(pending, bootstrapMessage);
    if (bootstrap.error && !bootstrap.resolvedId) {
      this.pendingSessions.delete(this.pendingKey(provider, id));
      this.getRuntime(provider).clearSession(id);
      sendJson(res, 500, { error: bootstrap.error, provider });
      return;
    }

    const resolved = await this.finalizePendingSession(pending, bootstrap.resolvedId || id, 12000);
    if (resolved) {
      const actualId = resolved.resolvedId || resolved.conversation.id;
      const response: Record<string, unknown> = {
        ...this.serializeConversation(provider, resolved.conversation, this.getRuntime(provider), actualId),
        requestedId: id,
      };
      if (bootstrap.error) {
        response.bootstrapWarning = bootstrap.error;
      }
      if (pending.model) {
        response.model = pending.model;
      }
      sendJson(res, 201, response);
      return;
    }

    const response: Record<string, unknown> = {
      id,
      provider,
      name: pending.name,
      projectPath: normalizedProjectPath,
      status: 'not_started',
    };
    if (pending.model) {
      response.model = pending.model;
    }

    response.bootstrapStarted = true;
    sendJson(res, 202, response);
  }

  private handleGet(url: URL, id: string, res: http.ServerResponse): void {
    const provider = this.resolveProvider(url.searchParams.get('provider'), id);
    if (!provider) {
      sendJson(res, 400, { error: 'Invalid provider' });
      return;
    }

    const pending = this.getPendingSession(provider, id);
    if (pending) {
      const response: Record<string, unknown> = {
        id: pending.id,
        provider,
        name: pending.name,
        projectPath: pending.projectPath,
        lastModified: pending.createdAt,
        status: this.getRuntime(provider).getStatus(id),
        messages: [],
      };
      if (pending.model) {
        response.model = pending.model;
      }
      sendJson(res, 200, response);
      return;
    }

    const resolved = this.resolveConversation(provider, id);
    if (!resolved) {
      sendJson(res, 404, { error: 'Conversation not found' });
      return;
    }

    const actualId = resolved.resolvedId || resolved.conversation.id;
    const messages = this.conversationManager.getConversationMessages(provider, actualId);
    const response: Record<string, unknown> = {
      ...this.serializeConversation(provider, resolved.conversation, this.getRuntime(provider), actualId),
      messages: messages || [],
    };
    if (id !== actualId) {
      response.requestedId = id;
      response.resolvedId = actualId;
    }
    sendJson(res, 200, response);
  }

  private handleDelete(url: URL, id: string, res: http.ServerResponse): void {
    const provider = this.resolveProvider(url.searchParams.get('provider'), id);
    if (!provider) {
      sendJson(res, 400, { error: 'Invalid provider' });
      return;
    }

    const runtime = this.getRuntime(provider);
    const pending = this.pendingSessions.delete(this.pendingKey(provider, id));
    runtime.stopProcess(id);
    runtime.clearSession(id);

    const resolved = this.resolveConversation(provider, id);
    const actualId = resolved?.resolvedId || resolved?.conversation.id;
    const deleted = actualId
      ? !!this.conversationManager.getProvider(provider)?.deleteConversation(actualId)
      : false;

    if (deleted) {
      this.conversationManager.refresh();
    }

    sendJson(res, 200, { success: true, provider, removedPending: pending || deleted });
  }

  private handleRename(url: URL, id: string, data: any, res: http.ServerResponse): void {
    const provider = this.resolveProvider(data.provider || url.searchParams.get('provider'), id);
    if (!provider) {
      sendJson(res, 400, { error: 'Invalid provider' });
      return;
    }

    const { name } = data;
    if (!name) {
      sendJson(res, 400, { error: 'name is required' });
      return;
    }

    const pending = this.getPendingSession(provider, id);
    if (pending) {
      pending.name = name;
      sendJson(res, 200, { success: true, provider });
      return;
    }

    const resolved = this.resolveConversation(provider, id);
    if (!resolved) {
      sendJson(res, 404, { error: 'Conversation not found' });
      return;
    }

    const actualId = resolved.resolvedId || resolved.conversation.id;
    const renamed = !!this.conversationManager.getProvider(provider)?.renameConversation(actualId, name);
    if (!renamed) {
      sendJson(res, 404, { error: 'Conversation not found' });
      return;
    }

    this.conversationManager.refresh();
    sendJson(res, 200, { success: true, provider });
  }

  private handleMessage(url: URL, id: string, data: any, res: http.ServerResponse): void {
    const provider = this.resolveProvider(data.provider || url.searchParams.get('provider'), id);
    if (!provider) {
      sendJson(res, 400, { error: 'Invalid provider' });
      return;
    }

    const { message } = data;
    if (!message) {
      sendJson(res, 400, { error: 'message is required' });
      return;
    }

    const runtime = this.getRuntime(provider);
    const pending = this.getPendingSession(provider, id);
    const resolved = this.resolveConversation(provider, id);
    const cwd = pending?.projectPath || resolved?.conversation.cwd || process.cwd();
    const model = runtime.getModel(id) || pending?.model || this.getDefaultModel(provider);

    if (pending) {
      this.schedulePendingPromotion(pending);
    }

    runtime.sendMessage(id, message, model, cwd, res);
  }

  private handleStop(url: URL, id: string, res: http.ServerResponse): void {
    const provider = this.resolveProvider(url.searchParams.get('provider'), id);
    if (!provider) {
      sendJson(res, 400, { error: 'Invalid provider' });
      return;
    }

    if (this.getRuntime(provider).stopProcess(id)) {
      sendJson(res, 200, { success: true, provider });
    } else {
      sendJson(res, 404, { error: 'No running process for this conversation' });
    }
  }

  private handleStatus(url: URL, id: string, res: http.ServerResponse): void {
    const provider = this.resolveProvider(url.searchParams.get('provider'), id);
    if (!provider) {
      sendJson(res, 400, { error: 'Invalid provider' });
      return;
    }

    sendJson(res, 200, { provider, status: this.getRuntime(provider).getStatus(id) });
  }

  private handleModel(url: URL, id: string, data: any, res: http.ServerResponse): void {
    const provider = this.resolveProvider(data.provider || url.searchParams.get('provider'), id);
    if (!provider) {
      sendJson(res, 400, { error: 'Invalid provider' });
      return;
    }

    const { model } = data;
    if (!model) {
      sendJson(res, 400, { error: 'model is required' });
      return;
    }

    this.getRuntime(provider).setModel(id, model);
    const pending = this.getPendingSession(provider, id);
    if (pending) {
      pending.model = model;
    }

    sendJson(res, 200, { success: true, provider, model });
  }

  private handleStream(url: URL, id: string, res: http.ServerResponse): void {
    const provider = this.resolveProvider(url.searchParams.get('provider'), id);
    if (!provider) {
      sendJson(res, 400, { error: 'Invalid provider' });
      return;
    }

    if (!this.getRuntime(provider).subscribe(id, res)) {
      sendJson(res, 404, { error: 'No active process for this conversation' });
    }
  }

  private handleListPermissions(url: URL, id: string, res: http.ServerResponse): void {
    const provider = this.resolveProvider(url.searchParams.get('provider'), id);
    if (!provider) {
      sendJson(res, 400, { error: 'Invalid provider' });
      return;
    }

    sendJson(res, 200, {
      provider,
      permissions: this.getRuntime(provider).getPendingPermissions(id),
    });
  }

  private handlePermissionResponse(url: URL, id: string, data: any, res: http.ServerResponse): void {
    const provider = this.resolveProvider(data.provider || url.searchParams.get('provider'), id);
    if (!provider) {
      sendJson(res, 400, { error: 'Invalid provider' });
      return;
    }

    const { requestId, allow } = data;
    if (!requestId || allow === undefined) {
      sendJson(res, 400, { error: 'requestId and allow are required' });
      return;
    }

    if (this.getRuntime(provider).respondToPermission(id, requestId, !!allow)) {
      sendJson(res, 200, { success: true, provider });
    } else {
      sendJson(res, 404, { error: 'Permission request not found' });
    }
  }

  private handleInterrupt(url: URL, id: string, res: http.ServerResponse): void {
    const provider = this.resolveProvider(url.searchParams.get('provider'), id);
    if (!provider) {
      sendJson(res, 400, { error: 'Invalid provider' });
      return;
    }

    if (this.getRuntime(provider).interruptProcess(id)) {
      sendJson(res, 200, { success: true, provider });
    } else {
      sendJson(res, 404, { error: 'No running process for this conversation' });
    }
  }

  private async handleHandoff(
    url: URL,
    id: string,
    data: any,
    res: http.ServerResponse,
  ): Promise<void> {
    const provider = this.resolveProvider(data.provider || url.searchParams.get('provider'), id);
    if (!provider) {
      sendJson(res, 400, { error: 'Invalid provider' });
      return;
    }

    const targetProvider = this.parseProvider(data.targetProvider);
    const targetSessionId = typeof data.targetSessionId === 'string' ? data.targetSessionId.trim() : '';
    const input: CreateSessionHandoffInput = {
      sourceProvider: provider,
      sourceSessionId: id,
      ...(targetProvider ? { targetProvider } : {}),
      ...(targetSessionId ? { targetSessionId } : {}),
      ...(data.artifactKind === 'note' || data.artifactKind === 'task-draft'
        ? { artifactKind: data.artifactKind }
        : {}),
      ...(typeof data.title === 'string' ? { title: data.title } : {}),
      ...(typeof data.instructions === 'string' ? { instructions: data.instructions } : {}),
      ...(typeof data.basePath === 'string' ? { basePath: data.basePath } : {}),
      ...(typeof data.relayToTarget === 'boolean' ? { relayToTarget: data.relayToTarget } : {}),
    };

    try {
      const result = await this.sessionHandoffService.createHandoff(input);
      sendJson(res, 200, result);
    } catch (error: any) {
      sendJson(res, 400, { error: error?.message || 'Failed to create handoff' });
    }
  }

  private schedulePendingPromotion(pending: PendingSession): void {
    const runtime = this.getRuntime(pending.provider);
    const provider = this.conversationManager.getProvider(pending.provider);
    if (!provider) { return; }

    let attempts = 0;
    const timer = setInterval(() => {
      attempts++;
      const resolvedId = runtime.getResolvedSessionId(pending.id);
      if (!resolvedId) {
        if (attempts > 30) {
          clearInterval(timer);
        }
        return;
      }

      provider.renameConversation(resolvedId, pending.name);
      this.pendingSessions.delete(this.pendingKey(pending.provider, pending.id));
      this.conversationManager.refresh();
      clearInterval(timer);
    }, 500);
  }

  private async bootstrapPendingSession(
    pending: PendingSession,
    message: string,
  ): Promise<BootstrapOutcome> {
    const runtime = this.getRuntime(pending.provider);
    const capture = new SseCaptureResponse();

    try {
      runtime.sendMessage(pending.id, message, pending.model, pending.projectPath, capture.asServerResponse());
    } catch (error: any) {
      return { error: error?.message || 'Failed to start session bootstrap' };
    }

    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const resolvedId = runtime.getResolvedSessionId(pending.id);
      if (resolvedId) {
        return { resolvedId, error: capture.getError() };
      }

      if (capture.isDone()) {
        return { resolvedId, error: capture.getError() };
      }

      await delay(250);
    }

    return {
      error: capture.getError() || 'Timed out waiting for session bootstrap',
      resolvedId: runtime.getResolvedSessionId(pending.id),
    };
  }

  private async finalizePendingSession(
    pending: PendingSession,
    candidateId: string,
    timeoutMs: number,
  ): Promise<ResolvedConversation | null> {
    const provider = this.conversationManager.getProvider(pending.provider);
    if (!provider) { return null; }

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const resolved = this.resolveConversation(pending.provider, candidateId);
      const actualId = resolved?.resolvedId || resolved?.conversation.id;
      if (resolved && actualId) {
        provider.prepareConversationForOpen?.(actualId);
        provider.renameConversation(actualId, pending.name);
        this.pendingSessions.delete(this.pendingKey(pending.provider, pending.id));
        this.conversationManager.refresh();
        return this.resolveConversation(pending.provider, actualId);
      }

      await delay(250);
    }

    return null;
  }

  private serializeConversation(
    provider: ApiProviderId,
    conversation: ConversationRecord,
    runtime: RuntimeManager,
    requestedId?: string,
  ): Record<string, unknown> {
    return {
      id: requestedId || conversation.id,
      provider,
      name: conversation.customTitle || conversation.name || conversation.summary,
      projectPath: conversation.cwd,
      lastModified: conversation.lastModified,
      fileSize: conversation.fileSize,
      gitBranch: conversation.gitBranch,
      status: runtime.getStatus(requestedId || conversation.id),
    };
  }

  private resolveConversation(provider: ApiProviderId, id: string): ResolvedConversation | null {
    const direct = this.conversationManager.getConversation(provider, id);
    if (direct) {
      return { conversation: direct };
    }

    const resolvedId = this.getRuntime(provider).getResolvedSessionId(id);
    if (!resolvedId) {
      return null;
    }

    const resolved = this.conversationManager.getConversation(provider, resolvedId);
    if (!resolved) {
      return null;
    }

    return { conversation: resolved, resolvedId };
  }

  private getRuntime(provider: ApiProviderId): RuntimeManager {
    return provider === 'codex' ? this.codexProcessManager : this.claudeProcessManager;
  }

  private getPendingSession(provider: ApiProviderId, id: string): PendingSession | undefined {
    return this.pendingSessions.get(this.pendingKey(provider, id));
  }

  private pendingKey(provider: ApiProviderId, id: string): string {
    return `${provider}:${id}`;
  }

  private getDefaultModel(provider: ApiProviderId): string | undefined {
    return provider === 'claude' ? 'sonnet' : undefined;
  }

  private getCreateBootstrapMessage(provider: ApiProviderId): string {
    return CREATE_BOOTSTRAP_PROMPTS[provider];
  }

  private parseListProvider(value: string | null | undefined): ApiListProvider | null {
    if (!value) { return 'all'; }
    if (value === 'all') { return 'all'; }
    return this.parseProvider(value);
  }

  private parseProvider(value: string | null | undefined): ApiProviderId | null {
    if (!value) { return null; }
    return value === 'claude' || value === 'codex' ? value : null;
  }

  private sameProjectPath(left?: string, right?: string): boolean {
    return this.normalizeProjectPath(left) === this.normalizeProjectPath(right);
  }

  private normalizeProjectPath(projectPath?: string): string | undefined {
    if (!projectPath) { return undefined; }
    try {
      return fs.realpathSync(projectPath);
    } catch {
      return path.resolve(projectPath);
    }
  }

  private resolveProvider(value: string | null | undefined, id?: string): ApiProviderId | null {
    const parsed = this.parseProvider(value);
    if (value && !parsed) {
      return null;
    }
    if (parsed) {
      return parsed;
    }

    if (id) {
      for (const provider of ['claude', 'codex'] as const) {
        if (this.pendingSessions.has(this.pendingKey(provider, id))) {
          return provider;
        }
      }

      const conversation = this.conversationManager.getConversationById(id);
      if (conversation) {
        return conversation.provider;
      }

      for (const provider of ['claude', 'codex'] as const) {
        if (this.getRuntime(provider).getResolvedSessionId(id)) {
          return provider;
        }
      }
    }

    return 'claude';
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
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
    'Pragma': 'no-cache',
    'Expires': '0',
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
