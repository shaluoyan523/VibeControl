import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as vscode from 'vscode';
import { ClaudeSession, ProjectGroup } from './types';

/**
 * Reads Claude Code session data directly from ~/.claude/projects/.
 * Each project directory contains .jsonl session files.
 */
export class SessionManager {
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;
  readonly projectsDir: string;
  private watcher: fs.FSWatcher | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
    this.projectsDir = path.join(configDir, 'projects');
    this.startWatching();
  }

  private startWatching(): void {
    try {
      this.watcher = fs.watch(this.projectsDir, { recursive: true }, (_event, filename) => {
        if (filename && filename.endsWith('.jsonl')) {
          this.debouncedRefresh();
        }
      });
    } catch {
      setTimeout(() => this.startWatching(), 10000);
    }
  }

  private debouncedRefresh(): void {
    if (this.refreshTimer) { clearTimeout(this.refreshTimer); }
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      this._onDidChange.fire();
    }, 500);
  }

  refresh(): void {
    this._onDidChange.fire();
  }

  getProjectGroups(): ProjectGroup[] {
    if (!fs.existsSync(this.projectsDir)) { return []; }

    const dirs = fs.readdirSync(this.projectsDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);

    const groups: ProjectGroup[] = [];

    for (const dirName of dirs) {
      const dirPath = path.join(this.projectsDir, dirName);
      const sessions = this.readSessionsFromDir(dirPath);
      if (sessions.length > 0) {
        sessions.sort((a, b) => b.lastModified - a.lastModified);
        groups.push({ dirName, sessions });
      }
    }

    groups.sort((a, b) => {
      const aTime = a.sessions[0]?.lastModified || 0;
      const bTime = b.sessions[0]?.lastModified || 0;
      return bTime - aTime;
    });

    return groups;
  }

  /** Rename a session by appending a customTitle line to its .jsonl file */
  renameSession(sessionId: string, newTitle: string): boolean {
    const filePath = this.findSessionFile(sessionId);
    if (!filePath) { return false; }
    try {
      const line = JSON.stringify({ type: 'customTitle', customTitle: newTitle, sessionId });
      fs.appendFileSync(filePath, '\n' + line);
      return true;
    } catch {
      return false;
    }
  }

  /** Delete a session's .jsonl file and subagents dir */
  deleteSession(sessionId: string): boolean {
    const filePath = this.findSessionFile(sessionId);
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

  /** Get a single session by ID */
  getSession(sessionId: string): ClaudeSession | null {
    const filePath = this.findSessionFile(sessionId);
    if (!filePath) { return null; }
    return this.parseSessionFile(filePath, sessionId);
  }

  /** Get all message lines from a session's .jsonl file */
  getConversationMessages(sessionId: string): object[] | null {
    const filePath = this.findSessionFile(sessionId);
    if (!filePath) { return null; }
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      return content.split('\n')
        .filter(line => line.trim())
        .map(line => {
          try { return JSON.parse(line); }
          catch { return { raw: line }; }
        });
    } catch {
      return null;
    }
  }

  /** Find the .jsonl file for a session across all project dirs */
  findSessionFile(sessionId: string): string | null {
    if (!fs.existsSync(this.projectsDir)) { return null; }
    const dirs = fs.readdirSync(this.projectsDir, { withFileTypes: true }).filter(d => d.isDirectory());
    for (const dir of dirs) {
      const filePath = path.join(this.projectsDir, dir.name, `${sessionId}.jsonl`);
      if (fs.existsSync(filePath)) { return filePath; }
    }
    return null;
  }

  private readSessionsFromDir(dirPath: string): ClaudeSession[] {
    let files: string[];
    try {
      files = fs.readdirSync(dirPath).filter(f => f.endsWith('.jsonl'));
    } catch {
      return [];
    }

    const sessions: ClaudeSession[] = [];
    for (const file of files) {
      const sessionId = file.slice(0, -6);
      if (!this.isValidUUID(sessionId)) { continue; }
      const filePath = path.join(dirPath, file);
      const session = this.parseSessionFile(filePath, sessionId);
      if (session) { sessions.push(session); }
    }
    return sessions;
  }

  private parseSessionFile(filePath: string, sessionId: string): ClaudeSession | null {
    try {
      const stat = fs.statSync(filePath);
      const content = fs.readFileSync(filePath, 'utf-8');

      const firstNewline = content.indexOf('\n');
      const firstLine = firstNewline >= 0 ? content.slice(0, firstNewline) : content;
      if (firstLine.includes('"isSidechain":true') || firstLine.includes('"isSidechain": true')) {
        return null;
      }

      // cwd may be on any early line (not just the first), read head for it
      const head = content.slice(0, 4096);
      const cwd = this.extractField(head, 'cwd') || undefined;
      const tail = this.readTail(content);
      // customTitle may not be in the tail if the file grew — search the whole file
      // for the last occurrence so user renames are never lost
      const customTitle = this.extractLastField(content, 'customTitle') || undefined;
      const firstPrompt = this.extractFirstPrompt(content) || undefined;
      const summary = customTitle
        || this.extractField(tail, 'lastPrompt')
        || this.extractField(tail, 'summary')
        || firstPrompt
        || sessionId.slice(0, 8);
      const gitBranch = this.extractField(tail, 'gitBranch')
        || this.extractField(firstLine, 'gitBranch')
        || undefined;

      return {
        sessionId, summary, lastModified: stat.mtimeMs, fileSize: stat.size,
        cwd, gitBranch, customTitle, firstPrompt,
      };
    } catch {
      return null;
    }
  }

  private readTail(content: string): string {
    if (content.length <= 2048) { return content; }
    return content.slice(-2048);
  }

  private extractField(text: string, field: string): string | null {
    const pattern = new RegExp(`"${field}"\\s*:\\s*"([^"]*?)"`);
    const match = text.match(pattern);
    return match ? match[1] : null;
  }

  /** Find the last occurrence of a field in the entire file content */
  private extractLastField(text: string, field: string): string | null {
    const pattern = new RegExp(`"${field}"\\s*:\\s*"([^"]*?)"`, 'g');
    let last: string | null = null;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      last = match[1];
    }
    return last;
  }

  private extractFirstPrompt(content: string): string | null {
    const match = content.match(/"role"\s*:\s*"user".*?"text"\s*:\s*"([^"]{1,100})/);
    if (match) {
      return match[1].length >= 100 ? match[1] + '...' : match[1];
    }
    return null;
  }

  private isValidUUID(s: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
  }

  dispose(): void {
    this.watcher?.close();
    if (this.refreshTimer) { clearTimeout(this.refreshTimer); }
    this._onDidChange.dispose();
  }
}
