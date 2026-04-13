import * as child_process from 'child_process';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import * as fs from 'fs';
import { resolveCodexExecutable } from '../codexCli';
import {
  CodexSessionIndex,
  collectCodexSessionSnapshots,
  readCodexSessionMetadata,
  readCodexSessionPreview,
} from '../codexSessionIndex';
import { logDebug } from '../debugLog';
import { getCodexHomeDir, getCodexSessionsDir } from '../runtimePaths';
import { ConversationProvider, CreateConversationInput } from './types';
import { ConversationRecord } from '../types';

const BOOTSTRAP_PROMPT = 'Which model are you using? What path are you bound to?';
const OFFICIAL_CODEX_EXTENSION_ID = 'openai.chatgpt';
const OFFICIAL_CODEX_EDITOR_ID = 'chatgpt.conversationEditor';
const OFFICIAL_CODEX_URI_SCHEME = 'openai-codex';
const OFFICIAL_CODEX_ROUTE_AUTHORITY = 'route';

interface CodexMetadata {
  customTitles?: Record<string, string>;
  deletedIds?: string[];
  pending?: PendingCodexConversation[];
}

interface PendingCodexConversation {
  id: string;
  name: string;
  projectPath?: string;
  model?: string;
  createdAt: number;
}

type PendingResolutionHandler = (conversation: ConversationRecord) => void;

interface OfficialConversationTabMatch {
  tab: vscode.Tab;
  group: vscode.TabGroup;
}

interface OfficialConversationTarget {
  scheme: string;
  authority: string;
  path: string;
  conversationId: string | null;
}

interface OpenConversationOptions {
  newTab: boolean;
  preferExistingTab: boolean;
  allowRouteCommandFallback: boolean;
}

const EDITOR_GROUP_FOCUS_COMMANDS = new Map<number, string>([
  [vscode.ViewColumn.One, 'workbench.action.focusFirstEditorGroup'],
  [vscode.ViewColumn.Two, 'workbench.action.focusSecondEditorGroup'],
  [vscode.ViewColumn.Three, 'workbench.action.focusThirdEditorGroup'],
  [vscode.ViewColumn.Four, 'workbench.action.focusFourthEditorGroup'],
  [vscode.ViewColumn.Five, 'workbench.action.focusFifthEditorGroup'],
  [vscode.ViewColumn.Six, 'workbench.action.focusSixthEditorGroup'],
  [vscode.ViewColumn.Seven, 'workbench.action.focusSeventhEditorGroup'],
  [vscode.ViewColumn.Eight, 'workbench.action.focusEighthEditorGroup'],
  [vscode.ViewColumn.Nine, 'workbench.action.focusNinthEditorGroup'],
]);

export class CodexProvider implements ConversationProvider {
  readonly id = 'codex' as const;
  readonly label = 'Codex';

  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;
  private readonly codexRoot = getCodexHomeDir();
  private readonly sessionsDir = getCodexSessionsDir();
  private readonly metadataPath = path.join(this.codexRoot, 'vibe-control-codex.json');
  private readonly codexExecutable = resolveCodexExecutable();
  private readonly sessionIndex = new CodexSessionIndex<ConversationRecord>();
  private watcher: fs.FSWatcher | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.startWatching();
  }

  private trace(message: string): void {
    logDebug(`codex ${message}`);
    console.info(`Vibe Control Codex: ${message}`);
  }

  private traceWarn(message: string): void {
    logDebug(`codex WARN ${message}`);
    console.warn(`Vibe Control Codex: ${message}`);
  }

  listConversations(): ConversationRecord[] {
    const metadata = this.readMetadata();
    const deletedIds = new Set(metadata.deletedIds || []);
    const customTitles = metadata.customTitles || {};
    const conversations = this.readSessionFiles()
      .filter(session => !deletedIds.has(session.id))
      .map(session => ({
        ...session,
        customTitle: customTitles[session.id] || session.customTitle,
        name: customTitles[session.id] || session.name,
      }));

    const pending = (metadata.pending || []).map(item => ({
      provider: this.id,
      id: item.id,
      name: item.name,
      summary: item.name,
      lastModified: item.createdAt,
      fileSize: 0,
      cwd: item.projectPath,
      status: 'not_started' as const,
      isPending: true,
    }));

    return [...conversations, ...pending]
      .sort((a, b) => b.lastModified - a.lastModified);
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

  async createConversation(input: CreateConversationInput): Promise<ConversationRecord | null> {
    return this.createConversationInternal(input, true);
  }

  async activateConversation(conversation: ConversationRecord): Promise<void> {
    this.trace(`activateConversation id=${conversation.id}`);
    await this.openConversationInternal(conversation, {
      newTab: false,
      preferExistingTab: true,
      allowRouteCommandFallback: true,
    });
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
      await this.createConversationInternal(input, false, (conversation) => finish(conversation));
    });
  }

  private async createConversationInternal(
    input: CreateConversationInput,
    autoOpen: boolean,
    onResolved?: PendingResolutionHandler,
  ): Promise<ConversationRecord | null> {
    const metadata = this.readMetadata();
    const projectPath = this.normalizeProjectPath(input.projectPath);
    const pending: PendingCodexConversation = {
      id: `pending-${Date.now()}`,
      name: input.name,
      projectPath,
      model: input.model,
      createdAt: Date.now(),
    };

    metadata.pending = [...(metadata.pending || []), pending];
    this.writeMetadata(metadata);
    this._onDidChange.fire();

    try {
      const sessionId = await this.bootstrapConversationViaCli(projectPath, input.model, BOOTSTRAP_PROMPT);
      const conversation = this.finalizePendingConversation(pending, sessionId);
      if (!conversation) {
        this.removePendingConversation(pending.id);
        return null;
      }

      onResolved?.(conversation);
      if (autoOpen) {
        setTimeout(() => {
          void this.openConversation(conversation, true);
        }, 200);
      }
      return conversation;
    } catch (error) {
      this.removePendingConversation(pending.id);
      if (autoOpen) {
        const message = error instanceof Error ? error.message : String(error);
        void vscode.window.showWarningMessage(`Failed to create Codex session: ${message}`);
      }
      return null;
    }
  }

  async openConversation(conversation: ConversationRecord, newTab = false): Promise<void> {
    this.trace(`openConversation id=${conversation.id} newTab=${newTab}`);
    await this.openConversationInternal(conversation, {
      newTab,
      preferExistingTab: !newTab,
      allowRouteCommandFallback: true,
    });
  }

  async openConversationInTerminal(conversation: ConversationRecord): Promise<void> {
    if (conversation.isPending) {
      void vscode.window.showInformationMessage('Codex session is still being created. Wait until it is available before opening the CLI.');
      return;
    }
    this.launchCodexTerminal(this.normalizeProjectPath(conversation.cwd), undefined, conversation.id);
  }

  private async openConversationInternal(
    conversation: ConversationRecord,
    options: OpenConversationOptions,
  ): Promise<void> {
    this.trace(
      `openConversationInternal id=${conversation.id} newTab=${options.newTab} preferExistingTab=${options.preferExistingTab} allowRouteFallback=${options.allowRouteCommandFallback}`,
    );
    if (conversation.isPending) {
      this.traceWarn(`conversation ${conversation.id} is pending`);
      await vscode.commands.executeCommand('chatgpt.openSidebar');
      vscode.window.showInformationMessage('Codex session is still being created. It will open automatically once ready.');
      return;
    }

    const sessionId = conversation.id;
    const filePath = this.findSessionFile(sessionId);
    if (!filePath) {
      this.traceWarn(`session file missing for ${sessionId}, falling back to terminal`);
      const projectPath = this.normalizeProjectPath(conversation.cwd);
      this.launchCodexTerminal(projectPath, undefined, sessionId);
      return;
    }

    const cwd = this.normalizeProjectPath(conversation.cwd);
    let metadata = this.getSessionMetadata(sessionId, filePath);
    if (metadata?.source !== 'vscode' && this.promoteSessionForTabOpen(sessionId, filePath)) {
      metadata = this.getSessionMetadata(sessionId, filePath);
    }
    this.trace(`session ${sessionId} metadataSource=${metadata?.source ?? 'unknown'}`);

    if (metadata?.source === 'vscode') {
      const uri = this.buildOfficialConversationUri(conversation.id);
      const existingTab = options.preferExistingTab ? this.findOfficialConversationTab(uri) : null;
      this.trace(`session ${sessionId} existingTab=${existingTab ? 'yes' : 'no'}`);

      if (existingTab) {
        const revealed = await this.revealOfficialConversationTab(existingTab, uri);
        this.trace(`session ${sessionId} revealExistingTab=${revealed}`);
        if (revealed) {
          if (
            options.allowRouteCommandFallback
            && await this.openOfficialConversationViaCommand(sessionId, uri)
          ) {
            this.trace(`session ${sessionId} refreshed existing tab via route command`);
            return;
          }
          this.traceWarn(`session ${sessionId} existing tab reveal did not confirm route command reload; continuing with reopen flow`);
        }
      }

      try {
        this.trace(`session ${sessionId} opening official editor`);
        await this.openOfficialConversationEditor(uri, options.newTab);
        this.trace(`session ${sessionId} official editor open completed`);
        return;
      } catch (directOpenError) {
        this.traceWarn(`session ${sessionId} direct editor open failed: ${describeError(directOpenError)}`);
        try {
          await this.primeOfficialCodexConversation(sessionId);
          this.trace(`session ${sessionId} primed official conversation`);
          const primedTab = options.preferExistingTab ? this.findOfficialConversationTab(uri) : null;
          this.trace(`session ${sessionId} primedExistingTab=${primedTab ? 'yes' : 'no'}`);
          if (primedTab) {
            const revealed = await this.revealOfficialConversationTab(primedTab, uri);
            this.trace(`session ${sessionId} revealPrimedTab=${revealed}`);
            if (revealed) {
              if (
                options.allowRouteCommandFallback
                && await this.openOfficialConversationViaCommand(sessionId, uri)
              ) {
                this.trace(`session ${sessionId} refreshed primed tab via route command`);
                return;
              }
              this.traceWarn(`session ${sessionId} primed tab reveal did not confirm route command reload; continuing with reopen flow`);
            }
          }
          this.trace(`session ${sessionId} reopening official editor after prime`);
          await this.openOfficialConversationEditor(uri, options.newTab);
          this.trace(`session ${sessionId} official editor reopen completed`);
          return;
        } catch (primedOpenError) {
          if (options.allowRouteCommandFallback && await this.openOfficialConversationViaCommand(sessionId, uri)) {
            this.trace(`session ${sessionId} route command fallback succeeded`);
            return;
          }
          this.traceWarn(
            `session ${sessionId} prime/open flow failed: first=${describeError(directOpenError)} second=${describeError(primedOpenError)}`,
          );
          const firstMessage = describeError(directOpenError);
          const secondMessage = describeError(primedOpenError);
          void vscode.window.showWarningMessage(
            `Codex 标签页打开失败，已降级到终端恢复。首次错误: ${firstMessage}; 重试错误: ${secondMessage}`,
          );
        }
      }
    }

    // Fallback to terminal if the webview path is unavailable.
    this.traceWarn(`session ${sessionId} is not vscode-backed, falling back to terminal`);
    this.launchCodexTerminal(cwd, undefined, conversation.id);
  }

  renameConversation(id: string, newTitle: string): boolean {
    const metadata = this.readMetadata();
    const pending = metadata.pending?.find(item => item.id === id);
    if (pending) {
      pending.name = newTitle;
      this.writeMetadata(metadata);
      this._onDidChange.fire();
      return true;
    }

    metadata.customTitles = metadata.customTitles || {};
    metadata.customTitles[id] = newTitle;
    this.writeMetadata(metadata);
    this._onDidChange.fire();
    return true;
  }

  deleteConversation(id: string): boolean {
    const metadata = this.readMetadata();
    const pending = metadata.pending || [];
    const nextPending = pending.filter(item => item.id !== id);
    if (nextPending.length !== pending.length) {
      metadata.pending = nextPending;
      this.writeMetadata(metadata);
      this._onDidChange.fire();
      return true;
    }

    metadata.deletedIds = Array.from(new Set([...(metadata.deletedIds || []), id]));
    this.writeMetadata(metadata);
    this._onDidChange.fire();
    return true;
  }

  prepareConversationForOpen(id: string): boolean {
    const filePath = this.findSessionFile(id);
    if (!filePath) { return false; }
    return this.promoteSessionForTabOpen(id, filePath);
  }

  dispose(): void {
    this.watcher?.close();
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
    this._onDidChange.dispose();
  }

  private startWatching(): void {
    try {
      if (!fs.existsSync(this.sessionsDir)) { return; }
      this.watcher = fs.watch(this.sessionsDir, { recursive: true }, () => this.debouncedRefresh());
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

  private promoteSessionForTabOpen(id: string, filePath: string): boolean {
    const metadata = this.getSessionMetadata(id, filePath);
    if (!metadata) { return false; }
    if (metadata.source === 'vscode' && metadata.originator === 'codex_vscode') {
      return true;
    }

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

  private getSessionMetadata(id: string, filePath?: string): { source: string | null; originator: string | null } | null {
    const targetPath = filePath || this.findSessionFile(id);
    if (!targetPath) { return null; }
    return readCodexSessionMetadata(targetPath);
  }

  private readSessionFiles(): ConversationRecord[] {
    const snapshots = collectCodexSessionSnapshots(this.sessionsDir);
    return this.sessionIndex.reconcile(
      snapshots,
      snapshot => readCodexSessionPreview(snapshot, this.normalizeProjectPath.bind(this)),
    );
  }

  private findSessionFile(id: string): string | null {
    const indexed = this.sessionIndex.findFilePath(id);
    if (indexed) { return indexed; }
    this.readSessionFiles();
    return this.sessionIndex.findFilePath(id);
  }

  private launchCodexTerminal(cwd?: string, model?: string, resumeId?: string): void {
    const terminal = vscode.window.createTerminal({
      name: resumeId ? `Codex Resume ${resumeId.slice(0, 8)}` : 'Codex',
      cwd: cwd || os.homedir(),
    });
    terminal.show();

    const parts = ['codex'];
    if (resumeId) {
      // `codex resume <id>` automatically restores original cwd; don't pass -C
      parts.push('resume', resumeId);
    } else {
      if (cwd) {
        parts.push('-C', this.quoteShell(cwd));
      }
    }
    if (model) {
      parts.push('-m', this.quoteShell(model));
    }

    terminal.sendText(parts.join(' '), true);
  }

  private quoteShell(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`;
  }

  private async bootstrapConversationViaCli(
    cwd: string | undefined,
    model: string | undefined,
    prompt: string,
    timeoutMs = 90000,
  ): Promise<string> {
    const normalizedCwd = this.normalizeProjectPath(cwd);
    if (!normalizedCwd) {
      throw new Error('Cannot determine project path');
    }

    return new Promise((resolve, reject) => {
      const args = [
        'exec',
        '--json',
        '--skip-git-repo-check',
        '-C',
        normalizedCwd,
        '--sandbox',
        'workspace-write',
      ];
      if (model) {
        args.push('-m', model);
      }
      args.push('--', prompt);

      const proc = child_process.spawn(this.codexExecutable, args, {
        cwd: normalizedCwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env },
      });

      let buffer = '';
      let stderr = '';
      let resolvedSessionId: string | null = null;
      let settled = false;

      const finish = (fn: () => void) => {
        if (settled) { return; }
        settled = true;
        clearTimeout(timeout);
        fn();
      };

      const timeout = setTimeout(() => {
        try { proc.kill('SIGTERM'); } catch {}
        finish(() => reject(new Error(`Timed out waiting for Codex bootstrap after ${timeoutMs}ms`)));
      }, timeoutMs);

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
            // Ignore malformed CLI lines and keep scanning.
          }
        }
      });

      proc.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      proc.on('error', (error) => {
        finish(() => reject(error));
      });

      proc.on('exit', async (code) => {
        if (!resolvedSessionId) {
          finish(() => reject(new Error(stderr.trim() || `Codex exited with code ${code}`)));
          return;
        }

        try {
          await this.waitForSessionFile(resolvedSessionId, 15000);
          finish(() => resolve(resolvedSessionId!));
        } catch (error) {
          finish(() => reject(error));
        }
      });
    });
  }

  private async waitForSessionFile(sessionId: string, timeoutMs: number): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const filePath = this.findSessionFile(sessionId);
      if (filePath) {
        return filePath;
      }
      await delay(250);
    }
    throw new Error(`Timed out waiting for Codex session file ${sessionId}`);
  }

  private finalizePendingConversation(
    pending: PendingCodexConversation,
    sessionId: string,
  ): ConversationRecord | null {
    const metadata = this.readMetadata();
    metadata.pending = (metadata.pending || []).filter(item => item.id !== pending.id);
    metadata.customTitles = metadata.customTitles || {};
    metadata.customTitles[sessionId] = pending.name;
    this.writeMetadata(metadata);
    this._onDidChange.fire();
    return this.getConversation(sessionId);
  }

  private removePendingConversation(pendingId: string): void {
    const metadata = this.readMetadata();
    metadata.pending = (metadata.pending || []).filter(item => item.id !== pendingId);
    this.writeMetadata(metadata);
    this._onDidChange.fire();
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
      // Ignore metadata write failures and keep the provider best-effort.
    }
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

  private getSessionSource(id: string): string | null {
    const filePath = this.findSessionFile(id);
    if (!filePath) { return null; }

    try {
      const firstLine = fs.readFileSync(filePath, 'utf-8').split('\n').find(line => line.trim());
      if (!firstLine) { return null; }
      const first = JSON.parse(firstLine);
      return typeof first?.payload?.source === 'string' ? first.payload.source : null;
    } catch {
      return null;
    }
  }

  private async primeOfficialCodexConversation(conversationId: string): Promise<void> {
    if (!vscode.extensions.getExtension(OFFICIAL_CODEX_EXTENSION_ID)) {
      return;
    }

    try {
      const route = vscode.Uri.from({
        scheme: vscode.env.uriScheme,
        authority: OFFICIAL_CODEX_EXTENSION_ID,
        path: `/local/${conversationId}`,
      });
      await vscode.env.openExternal(route);
      await delay(150);
      return;
    } catch {
      // Fall through to sidebar wake-up below.
    }

    try {
      await vscode.commands.executeCommand('chatgpt.openSidebar');
      await delay(150);
    } catch {
      // Best effort only. Caller decides the final fallback path.
    }
  }

  private buildOfficialConversationUri(conversationId: string): vscode.Uri {
    return vscode.Uri.file(`/local/${conversationId}`).with({
      scheme: OFFICIAL_CODEX_URI_SCHEME,
      authority: OFFICIAL_CODEX_ROUTE_AUTHORITY,
    });
  }

  private async openOfficialConversationViaCommand(conversationId: string, uri: vscode.Uri): Promise<boolean> {
    try {
      this.trace(`session ${conversationId} invoking chatgpt.openConversationById`);
      await vscode.commands.executeCommand('chatgpt.openConversationById', conversationId);
      await this.waitForOfficialConversationEditor(uri, 2000);
      return true;
    } catch {
      this.traceWarn(`session ${conversationId} chatgpt.openConversationById failed`);
      return false;
    }
  }

  private async openOfficialConversationEditor(uri: vscode.Uri, _newTab: boolean): Promise<void> {
    const existingTab = this.findOfficialConversationTab(uri);
    if (existingTab && await this.revealOfficialConversationTab(existingTab, uri)) {
      return;
    }

    const viewColumn = existingTab?.group.viewColumn
      ?? vscode.window.activeTextEditor?.viewColumn
      ?? vscode.window.tabGroups.activeTabGroup.viewColumn
      ?? vscode.ViewColumn.Active;

    await vscode.commands.executeCommand('vscode.openWith', uri, OFFICIAL_CODEX_EDITOR_ID, {
      viewColumn,
      preserveFocus: false,
      // Always pin session tabs so list clicks reliably surface a stable editor tab.
      preview: false,
    });

    await this.waitForOfficialConversationEditor(uri, 2000);
  }

  private async waitForOfficialConversationEditor(uri: vscode.Uri, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.findOfficialConversationTab(uri)) {
        return;
      }
      await delay(50);
    }

    throw new Error(`Codex editor did not become visible for ${uri.toString()}`);
  }

  private async revealOfficialConversationTab(match: OfficialConversationTabMatch, uri: vscode.Uri): Promise<boolean> {
    const focusGroupCommand = EDITOR_GROUP_FOCUS_COMMANDS.get(match.group.viewColumn ?? -1);
    if (focusGroupCommand) {
      try {
        await vscode.commands.executeCommand(focusGroupCommand);
      } catch {
        // Fall through to tab-selection/openWith fallback below.
      }
    }

    const tabIndex = match.group.tabs.findIndex(tab => tab === match.tab);
    if (tabIndex >= 0 && tabIndex < 9) {
      try {
        await vscode.commands.executeCommand(`workbench.action.openEditorAtIndex${tabIndex + 1}`);
      } catch {
        // Some VS Code builds may not expose these commands; fallback below.
      }
    }

    await delay(50);
    if (this.isOfficialConversationEditorVisible(uri)) {
      return true;
    }

    try {
      await vscode.commands.executeCommand('vscode.openWith', uri, OFFICIAL_CODEX_EDITOR_ID, {
        viewColumn: match.group.viewColumn,
        preserveFocus: false,
        preview: false,
      });
      await delay(50);
    } catch {
      return false;
    }

    return this.isOfficialConversationEditorVisible(uri);
  }

  private isOfficialConversationEditorVisible(uri: vscode.Uri): boolean {
    const activeTab = vscode.window.tabGroups.activeTabGroup.activeTab;
    return !!activeTab && this.tabMatchesUri(activeTab, uri);
  }

  private findOfficialConversationTab(uri: vscode.Uri): OfficialConversationTabMatch | null {
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        if (this.tabMatchesUri(tab, uri)) {
          return { tab, group };
        }
      }
    }
    return null;
  }

  private tabMatchesUri(tab: vscode.Tab, expectedUri: vscode.Uri): boolean {
    const input = tab.input;
    const actualUri = this.getTabInputUri(input);
    if (!actualUri) {
      return false;
    }

    const expected = this.describeOfficialConversationTarget(expectedUri);
    const actual = this.describeOfficialConversationTarget(actualUri);

    if (
      expected.conversationId &&
      actual.conversationId &&
      expected.conversationId === actual.conversationId
    ) {
      return this.getTabInputViewType(input) === OFFICIAL_CODEX_EDITOR_ID || actual.scheme === OFFICIAL_CODEX_URI_SCHEME;
    }

    return expected.scheme === actual.scheme
      && expected.authority === actual.authority
      && expected.path === actual.path;
  }

  private getTabInputUri(input: unknown): vscode.Uri | null {
    if (input instanceof vscode.TabInputCustom || input instanceof vscode.TabInputText) {
      return input.uri;
    }

    if (input && typeof input === 'object' && 'uri' in input) {
      const uri = (input as { uri?: unknown }).uri;
      return uri instanceof vscode.Uri ? uri : null;
    }

    return null;
  }

  private getTabInputViewType(input: unknown): string | null {
    if (input instanceof vscode.TabInputCustom) {
      return input.viewType;
    }

    if (input && typeof input === 'object' && 'viewType' in input) {
      const viewType = (input as { viewType?: unknown }).viewType;
      return typeof viewType === 'string' ? viewType : null;
    }

    return null;
  }

  private describeOfficialConversationTarget(uri: vscode.Uri): OfficialConversationTarget {
    const path = uri.path.startsWith('/') ? uri.path : `/${uri.path}`;
    const parts = path.slice(1).split('/');
    const conversationId = parts.length >= 2 && (parts[0] === 'local' || parts[0] === 'remote')
      ? parts[1]
      : null;

    return {
      scheme: uri.scheme,
      authority: uri.authority,
      path,
      conversationId,
    };
  }

}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function describeError(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return String(error);
}
