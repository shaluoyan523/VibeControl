import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import { HttpConversationProvider } from '../httpRuntime';
import { ProcessManager } from '../processManager';
import { getClaudeConfigDir } from '../runtimePaths';
import { ConversationRecord } from '../types';

const CLAUDE_BOOTSTRAP_PROMPT = 'Reply with the current working directory and model for this new session.';

export class HeadlessClaudeProvider implements HttpConversationProvider {
  readonly id = 'claude' as const;
  readonly label = 'Claude Code';
  private readonly projectsDir: string;

  constructor(
    private readonly extensionRoot: string,
    private readonly processManager: ProcessManager,
  ) {
    const configDir = getClaudeConfigDir();
    this.projectsDir = path.join(configDir, 'projects');
  }

  listConversations(): ConversationRecord[] {
    return this.getProjectGroups()
      .flatMap(group => group.sessions)
      .map(session => ({
        provider: this.id,
        id: session.sessionId,
        name: session.customTitle || session.summary,
        summary: session.summary,
        lastModified: session.lastModified,
        fileSize: session.fileSize,
        cwd: session.cwd,
        gitBranch: session.gitBranch,
        customTitle: session.customTitle,
        firstPrompt: session.firstPrompt,
        status: this.processManager.getStatus(session.sessionId),
      }));
  }

  getConversation(id: string): ConversationRecord | null {
    const session = this.getSession(id);
    if (!session) { return null; }
    return {
      provider: this.id,
      id: session.sessionId,
      name: session.customTitle || session.summary,
      summary: session.summary,
      lastModified: session.lastModified,
      fileSize: session.fileSize,
      cwd: session.cwd,
      gitBranch: session.gitBranch,
      customTitle: session.customTitle,
      firstPrompt: session.firstPrompt,
      status: this.processManager.getStatus(session.sessionId),
    };
  }

  getConversationMessages(id: string): object[] | null {
    const filePath = this.findSessionFile(id);
    if (!filePath) { return null; }
    try {
      return fs.readFileSync(filePath, 'utf-8')
        .split('\n')
        .filter(line => line.trim())
        .map(line => {
          try { return JSON.parse(line); }
          catch { return { raw: line }; }
        });
    } catch {
      return null;
    }
  }

  async createConversationAndWait(
    input: { name: string; projectPath?: string; model?: string },
    timeoutMs = 45000,
  ): Promise<ConversationRecord | null> {
    const cwd = normalizeProjectPath(input.projectPath);
    if (!cwd) {
      return null;
    }

    const requestedId = `headless-claude-${Date.now()}`;
    const capture = new SseCaptureResponse();
    const model = input.model || 'sonnet';

    this.processManager.sendMessage(
      requestedId,
      CLAUDE_BOOTSTRAP_PROMPT,
      model,
      cwd,
      capture.asServerResponse(),
    );

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const resolvedId = this.processManager.getResolvedSessionId(requestedId);
      if (resolvedId) {
        await waitFor(() => this.findSessionFile(resolvedId), 15000);
        this.renameConversation(resolvedId, input.name);
        return this.getConversation(resolvedId);
      }

      if (capture.isDone()) {
        break;
      }

      await delay(250);
    }

    return null;
  }

  renameConversation(id: string, newTitle: string): boolean {
    const filePath = this.findSessionFile(id);
    if (!filePath) { return false; }
    try {
      const line = JSON.stringify({ type: 'customTitle', customTitle: newTitle, sessionId: id });
      fs.appendFileSync(filePath, '\n' + line);
      return true;
    } catch {
      return false;
    }
  }

  deleteConversation(id: string): boolean {
    const filePath = this.findSessionFile(id);
    if (!filePath) { return false; }
    try {
      fs.unlinkSync(filePath);
      const subDir = filePath.replace(/\.jsonl$/, '');
      if (fs.existsSync(subDir) && fs.statSync(subDir).isDirectory()) {
        fs.rmSync(subDir, { recursive: true, force: true });
      }
      return true;
    } catch {
      return false;
    }
  }

  prepareConversationForOpen(): boolean {
    return true;
  }

  private getProjectGroups(): Array<{ dirName: string; sessions: HeadlessClaudeSession[] }> {
    if (!fs.existsSync(this.projectsDir)) { return []; }
    const dirs = fs.readdirSync(this.projectsDir, { withFileTypes: true })
      .filter(dir => dir.isDirectory())
      .map(dir => dir.name);

    const groups: Array<{ dirName: string; sessions: HeadlessClaudeSession[] }> = [];
    for (const dirName of dirs) {
      const dirPath = path.join(this.projectsDir, dirName);
      const sessions = this.readSessionsFromDir(dirPath);
      if (sessions.length === 0) { continue; }
      sessions.sort((left, right) => right.lastModified - left.lastModified);
      groups.push({ dirName, sessions });
    }

    groups.sort((left, right) => {
      const leftTime = left.sessions[0]?.lastModified || 0;
      const rightTime = right.sessions[0]?.lastModified || 0;
      return rightTime - leftTime;
    });
    return groups;
  }

  private getSession(sessionId: string): HeadlessClaudeSession | null {
    const filePath = this.findSessionFile(sessionId);
    if (!filePath) { return null; }
    return this.parseSessionFile(filePath, sessionId);
  }

  private findSessionFile(sessionId: string): string | null {
    if (!fs.existsSync(this.projectsDir)) { return null; }
    const dirs = fs.readdirSync(this.projectsDir, { withFileTypes: true }).filter(dir => dir.isDirectory());
    for (const dir of dirs) {
      const filePath = path.join(this.projectsDir, dir.name, `${sessionId}.jsonl`);
      if (fs.existsSync(filePath)) {
        return filePath;
      }
    }
    return null;
  }

  private readSessionsFromDir(dirPath: string): HeadlessClaudeSession[] {
    let files: string[];
    try {
      files = fs.readdirSync(dirPath).filter(file => file.endsWith('.jsonl'));
    } catch {
      return [];
    }

    const sessions: HeadlessClaudeSession[] = [];
    for (const file of files) {
      const sessionId = file.slice(0, -6);
      if (!isValidUUID(sessionId)) { continue; }
      const session = this.parseSessionFile(path.join(dirPath, file), sessionId);
      if (session) {
        sessions.push(session);
      }
    }
    return sessions;
  }

  private parseSessionFile(filePath: string, sessionId: string): HeadlessClaudeSession | null {
    try {
      const stat = fs.statSync(filePath);
      const content = fs.readFileSync(filePath, 'utf-8');
      const firstNewline = content.indexOf('\n');
      const firstLine = firstNewline >= 0 ? content.slice(0, firstNewline) : content;
      if (firstLine.includes('"isSidechain":true') || firstLine.includes('"isSidechain": true')) {
        return null;
      }

      const head = content.slice(0, 4096);
      const cwd = extractField(head, 'cwd') || undefined;
      const tail = content.length <= 2048 ? content : content.slice(-2048);
      const customTitle = extractLastField(content, 'customTitle') || undefined;
      const firstPrompt = extractFirstPrompt(content) || undefined;
      const summary = customTitle
        || extractField(tail, 'lastPrompt')
        || extractField(tail, 'summary')
        || firstPrompt
        || sessionId.slice(0, 8);
      const gitBranch = extractField(tail, 'gitBranch')
        || extractField(firstLine, 'gitBranch')
        || undefined;

      return {
        sessionId,
        summary,
        lastModified: stat.mtimeMs,
        fileSize: stat.size,
        cwd,
        gitBranch,
        customTitle,
        firstPrompt,
      };
    } catch {
      return null;
    }
  }
}

interface HeadlessClaudeSession {
  sessionId: string;
  summary: string;
  lastModified: number;
  fileSize: number;
  cwd?: string;
  gitBranch?: string;
  customTitle?: string;
  firstPrompt?: string;
}

function isValidUUID(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function extractField(text: string, field: string): string | null {
  const match = text.match(new RegExp(`"${field}"\\s*:\\s*"([^"]*?)"`));
  return match ? match[1] : null;
}

function extractLastField(text: string, field: string): string | null {
  const pattern = new RegExp(`"${field}"\\s*:\\s*"([^"]*?)"`, 'g');
  let last: string | null = null;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    last = match[1];
  }
  return last;
}

function extractFirstPrompt(content: string): string | null {
  const match = content.match(/"role"\s*:\s*"user".*?"text"\s*:\s*"([^"]{1,100})/);
  if (!match) { return null; }
  return match[1].length >= 100 ? `${match[1]}...` : match[1];
}

function normalizeProjectPath(projectPath?: string): string | undefined {
  if (!projectPath) { return undefined; }
  try {
    return fs.realpathSync(projectPath);
  } catch {
    return path.resolve(projectPath);
  }
}

async function waitFor<T>(factory: () => T | null | undefined, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = factory();
    if (value != null) {
      return value;
    }
    await delay(250);
  }
  throw new Error(`Timed out after ${timeoutMs}ms`);
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

class SseCaptureResponse extends EventEmitter {
  private finished = false;

  writeHead(_statusCode: number, _headers?: http.OutgoingHttpHeaders): this {
    return this;
  }

  write(_chunk: string | Buffer): boolean {
    return true;
  }

  end(_chunk?: string | Buffer): this {
    if (!this.finished) {
      this.finished = true;
      this.emit('done');
    }
    return this;
  }

  asServerResponse(): http.ServerResponse {
    return this as unknown as http.ServerResponse;
  }

  isDone(): boolean {
    return this.finished;
  }
}
