import * as vscode from 'vscode';
import { ProviderId } from './types';

const CLAUDE_VIEW_TYPE = 'claudeVSCodePanel';
const CODEX_EDITOR_VIEW_TYPE = 'chatgpt.conversationEditor';
const CODEX_URI_SCHEME = 'openai-codex';

export class ActiveSessionTracker implements vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  private readonly lastKnownByProvider = new Map<ProviderId, string>();
  private currentActive = new Map<ProviderId, string>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor() {
    this.currentActive = this.computeActiveSessions();
    this.disposables.push(
      this._onDidChange,
      vscode.window.tabGroups.onDidChangeTabs(() => this.refresh()),
      vscode.window.tabGroups.onDidChangeTabGroups(() => this.refresh()),
    );
  }

  dispose(): void {
    while (this.disposables.length > 0) {
      this.disposables.pop()?.dispose();
    }
  }

  markSessionLikelyActive(provider: ProviderId, sessionId: string): void {
    this.lastKnownByProvider.set(provider, sessionId);
    this.refresh();
  }

  isSessionActive(provider: ProviderId, sessionId: string): boolean {
    return this.currentActive.get(provider) === sessionId;
  }

  private refresh(): void {
    const next = this.computeActiveSessions();
    if (!mapsEqual(this.currentActive, next)) {
      this.currentActive = next;
      this._onDidChange.fire();
    }
  }

  private computeActiveSessions(): Map<ProviderId, string> {
    const next = new Map<ProviderId, string>();
    const activeTab = vscode.window.tabGroups.activeTabGroup.activeTab;
    if (!activeTab) {
      return next;
    }

    const input = activeTab.input;
    if (input instanceof vscode.TabInputCustom) {
      const codexSessionId = extractCodexConversationId(input.uri);
      if (
        codexSessionId
        && (input.viewType === CODEX_EDITOR_VIEW_TYPE || input.uri.scheme === CODEX_URI_SCHEME)
      ) {
        next.set('codex', codexSessionId);
      }
      return next;
    }

    if (input instanceof vscode.TabInputWebview && input.viewType === CLAUDE_VIEW_TYPE) {
      const claudeSessionId = this.lastKnownByProvider.get('claude');
      if (claudeSessionId) {
        next.set('claude', claudeSessionId);
      }
    }

    return next;
  }
}

function extractCodexConversationId(uri: vscode.Uri): string | null {
  const match = uri.path.match(/\/local\/([^/?#]+)/);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

function mapsEqual(left: Map<string, string>, right: Map<string, string>): boolean {
  if (left.size !== right.size) {
    return false;
  }
  for (const [key, value] of left.entries()) {
    if (right.get(key) !== value) {
      return false;
    }
  }
  return true;
}
