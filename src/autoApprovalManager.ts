import * as vscode from 'vscode';
import { CodexProcessManager } from './codexProcessManager';
import { ConversationManager } from './conversationManager';
import { ProcessManager } from './processManager';

type RuntimeManager = {
  getPendingPermissions(sessionId: string): Array<{ requestId?: string }>;
  respondToPermission(sessionId: string, requestId: string, allow: boolean): boolean;
};

export class AutoApprovalManager implements vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<boolean>();
  readonly onDidChange = this._onDidChange.event;

  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly conversationManager: ConversationManager,
    private readonly claudeProcessManager: ProcessManager,
    private readonly codexProcessManager: CodexProcessManager,
    private enabled: boolean,
    private readonly beforeSweep: () => Promise<void> | void,
    private readonly onApproved: () => void,
  ) {
    if (enabled) {
      this.start();
      void this.tick();
    }
  }

  dispose(): void {
    this.stop();
    this._onDidChange.dispose();
  }

  getEnabled(): boolean {
    return this.enabled;
  }

  async setEnabled(value: boolean): Promise<void> {
    if (this.enabled === value) { return; }
    this.enabled = value;
    if (value) {
      this.start();
      await this.tick();
    } else {
      this.stop();
    }
    this._onDidChange.fire(this.enabled);
  }

  private start(): void {
    if (this.timer) { return; }
    this.timer = setInterval(() => {
      void this.tick();
    }, 3 * 60 * 1000);
  }

  private stop(): void {
    if (!this.timer) { return; }
    clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    if (!this.enabled || this.running) { return; }
    this.running = true;
    try {
      await this.beforeSweep();
      let approvedCount = 0;
      for (const conversation of this.conversationManager.listConversations()) {
        const runtime = this.getRuntime(conversation.provider);
        for (const permission of runtime.getPendingPermissions(conversation.id)) {
          const requestId = typeof permission?.requestId === 'string' ? permission.requestId : '';
          if (!requestId) { continue; }
          if (runtime.respondToPermission(conversation.id, requestId, true)) {
            approvedCount += 1;
          }
        }
      }
      if (approvedCount > 0) {
        this.onApproved();
      }
    } finally {
      this.running = false;
    }
  }

  private getRuntime(provider: 'claude' | 'codex'): RuntimeManager {
    return provider === 'codex' ? this.codexProcessManager : this.claudeProcessManager;
  }
}
