import { ConversationProvider, CreateConversationInput } from './types';
import { ConversationRecord } from '../types';
import { SessionManager } from '../sessionManager';
import { ProcessManager } from '../processManager';
import { resolveClaudeCliScript } from '../claudeCli';
import * as vscode from 'vscode';

type OpenClaudeSession = (sessionId?: string, cwd?: string, newTab?: boolean) => Promise<void>;
type WaitForClaudeSessionRename = (title: string, onDiscovered?: (sessionId: string) => void) => void;

export class ClaudeProvider implements ConversationProvider {
  readonly id = 'claude' as const;
  readonly label = 'Claude Code';
  readonly onDidChange;

  constructor(
    private readonly sessionManager: SessionManager,
    private readonly processManager: ProcessManager,
    private readonly openClaudeSession: OpenClaudeSession,
    private readonly waitForNewSessionAndRename: WaitForClaudeSessionRename,
    extensionPath: string,
  ) {
    this.onDidChange = sessionManager.onDidChange;
    this.cliPath = resolveClaudeCliScript(extensionPath);
  }

  private readonly cliPath: string;

  listConversations(): ConversationRecord[] {
    return this.sessionManager.getProjectGroups()
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
    const session = this.sessionManager.getSession(id);
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
    return this.sessionManager.getConversationMessages(id);
  }

  async createConversation(input: CreateConversationInput): Promise<ConversationRecord | null> {
    await this.openClaudeSession(undefined, input.projectPath, true);
    this.waitForNewSessionAndRename(input.name);
    return null;
  }

  async createConversationAndWait(
    input: CreateConversationInput,
    timeoutMs = 45000,
  ): Promise<ConversationRecord | null> {
    return new Promise(async (resolve) => {
      let settled = false;
      const finish = (conversation: ConversationRecord | null) => {
        if (settled) { return; }
        settled = true;
        clearTimeout(timeout);
        resolve(conversation);
      };

      const timeout = setTimeout(() => finish(null), timeoutMs);

      await this.openClaudeSession(undefined, input.projectPath, true);
      this.waitForNewSessionAndRename(input.name, (sessionId) => {
        finish(this.getConversation(sessionId));
      });
    });
  }

  async openConversation(conversation: ConversationRecord, newTab = false): Promise<void> {
    await this.openClaudeSession(conversation.id, conversation.cwd, newTab);
  }

  async openConversationInTerminal(conversation: ConversationRecord): Promise<void> {
    const cwd = conversation.cwd;
    if (!cwd) {
      void vscode.window.showInformationMessage(`Session has no working directory: ${conversation.name}`);
      return;
    }

    const resumeId = this.processManager.getResolvedSessionId(conversation.id) || conversation.id;
    const terminal = vscode.window.createTerminal({
      name: `Claude Resume ${resumeId.slice(0, 8)}`,
      cwd,
    });
    terminal.show();
    terminal.sendText(this.buildTerminalCommand(resumeId), true);
  }

  private buildTerminalCommand(resumeId: string): string {
    return [
      this.quoteShell(process.execPath),
      this.quoteShell(this.cliPath),
      '--resume',
      this.quoteShell(resumeId),
    ].join(' ');
  }

  private quoteShell(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`;
  }

  renameConversation(id: string, newTitle: string): boolean {
    const renamed = this.sessionManager.renameSession(id, newTitle);
    if (renamed) {
      this.sessionManager.refresh();
    }
    return renamed;
  }

  deleteConversation(id: string): boolean {
    const deleted = this.sessionManager.deleteSession(id);
    if (deleted) {
      this.sessionManager.refresh();
    }
    return deleted;
  }
}
