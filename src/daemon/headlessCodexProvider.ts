import * as child_process from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { resolveCodexExecutable } from '../codexCli';
import {
  CodexSessionIndex,
  collectCodexSessionSnapshots,
  readCodexSessionPreview,
} from '../codexSessionIndex';
import { HttpConversationProvider } from '../httpRuntime';
import { getCodexHomeDir, getCodexSessionsDir } from '../runtimePaths';
import { ConversationRecord } from '../types';

const BOOTSTRAP_PROMPT = 'Which model are you using? What path are you bound to?';

interface CodexMetadata {
  customTitles?: Record<string, string>;
  deletedIds?: string[];
}

export class HeadlessCodexProvider implements HttpConversationProvider {
  readonly id = 'codex' as const;
  readonly label = 'Codex';
  private readonly codexRoot = getCodexHomeDir();
  private readonly sessionsDir = getCodexSessionsDir();
  private readonly metadataPath = path.join(this.codexRoot, 'vibe-control-codex.json');
  private readonly codexExecutable = resolveCodexExecutable();
  private readonly sessionIndex = new CodexSessionIndex<ConversationRecord>();

  listConversations(): ConversationRecord[] {
    const metadata = this.readMetadata();
    const deletedIds = new Set(metadata.deletedIds || []);
    const customTitles = metadata.customTitles || {};
    return this.readSessionFiles()
      .filter(session => !deletedIds.has(session.id))
      .map(session => ({
        ...session,
        customTitle: customTitles[session.id] || session.customTitle,
        name: customTitles[session.id] || session.name,
      }))
      .sort((left, right) => right.lastModified - left.lastModified);
  }

  getConversation(id: string): ConversationRecord | null {
    return this.listConversations().find(conversation => conversation.id === id) || null;
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
    timeoutMs = 90000,
  ): Promise<ConversationRecord | null> {
    const cwd = normalizeProjectPath(input.projectPath);
    if (!cwd) {
      return null;
    }

    const sessionId = await this.bootstrapConversationViaCli(cwd, input.model, BOOTSTRAP_PROMPT, timeoutMs);
    const conversation = this.finalizeConversation(sessionId, input.name);
    return conversation;
  }

  renameConversation(id: string, newTitle: string): boolean {
    const metadata = this.readMetadata();
    metadata.customTitles = metadata.customTitles || {};
    metadata.customTitles[id] = newTitle;
    this.writeMetadata(metadata);
    return true;
  }

  deleteConversation(id: string): boolean {
    const metadata = this.readMetadata();
    metadata.deletedIds = Array.from(new Set([...(metadata.deletedIds || []), id]));
    this.writeMetadata(metadata);
    return true;
  }

  prepareConversationForOpen(id: string): boolean {
    const filePath = this.findSessionFile(id);
    if (!filePath) { return false; }
    return this.promoteSessionForTabOpen(filePath);
  }

  private readSessionFiles(): ConversationRecord[] {
    const snapshots = collectCodexSessionSnapshots(this.sessionsDir);
    return this.sessionIndex.reconcile(
      snapshots,
      snapshot => readCodexSessionPreview(snapshot, normalizeProjectPath),
    );
  }

  private findSessionFile(id: string): string | null {
    const indexed = this.sessionIndex.findFilePath(id);
    if (indexed) { return indexed; }
    this.readSessionFiles();
    return this.sessionIndex.findFilePath(id);
  }

  private async bootstrapConversationViaCli(
    cwd: string,
    model: string | undefined,
    prompt: string,
    timeoutMs: number,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
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
      args.push('--', prompt);

      const proc = child_process.spawn(this.codexExecutable, args, {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env },
      });

      let resolvedSessionId: string | null = null;
      let buffer = '';
      let stderr = '';
      let settled = false;
      const timeout = setTimeout(() => {
        try { proc.kill('SIGTERM'); } catch {}
        finish(() => reject(new Error(`Timed out waiting for Codex bootstrap after ${timeoutMs}ms`)));
      }, timeoutMs);

      const finish = (fn: () => void) => {
        if (settled) { return; }
        settled = true;
        clearTimeout(timeout);
        fn();
      };

      proc.stdout?.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.trim()) { continue; }
          try {
            const parsed = JSON.parse(line);
            if (typeof parsed?.thread_id === 'string' && parsed.thread_id) {
              resolvedSessionId = parsed.thread_id;
            }
          } catch {
            // Ignore malformed lines.
          }
        }
      });

      proc.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      proc.on('error', error => finish(() => reject(error)));
      proc.on('exit', async (code) => {
        if (!resolvedSessionId) {
          finish(() => reject(new Error(stderr.trim() || `Codex exited with code ${code}`)));
          return;
        }
        try {
          await waitFor(() => this.findSessionFile(resolvedSessionId!), 15000);
          finish(() => resolve(resolvedSessionId!));
        } catch (error) {
          finish(() => reject(error));
        }
      });
    });
  }

  private finalizeConversation(sessionId: string, title: string): ConversationRecord | null {
    this.renameConversation(sessionId, title);
    this.prepareConversationForOpen(sessionId);
    return this.getConversation(sessionId);
  }

  private promoteSessionForTabOpen(filePath: string): boolean {
    try {
      const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
      const firstIndex = lines.findIndex(line => line.trim());
      if (firstIndex === -1) { return false; }
      const first = JSON.parse(lines[firstIndex]);
      first.payload = first.payload || {};
      first.payload.source = 'vscode';
      first.payload.originator = 'codex_vscode';
      lines[firstIndex] = JSON.stringify(first);
      fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');
      this.sessionIndex.invalidate(filePath);
      return true;
    } catch {
      return false;
    }
  }

  private readMetadata(): CodexMetadata {
    try {
      if (!fs.existsSync(this.metadataPath)) {
        return {};
      }
      return JSON.parse(fs.readFileSync(this.metadataPath, 'utf-8'));
    } catch {
      return {};
    }
  }

  private writeMetadata(metadata: CodexMetadata): void {
    try {
      if (!fs.existsSync(this.codexRoot)) {
        fs.mkdirSync(this.codexRoot, { recursive: true });
      }
      fs.writeFileSync(this.metadataPath, JSON.stringify(metadata, null, 2), 'utf-8');
    } catch {
      // Best-effort only.
    }
  }
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
