import * as vscode from 'vscode';
import { ProviderId } from './types';

type WorkingState = 'running' | 'waiting' | 'idle' | 'failed' | 'review' | 'unknown';

export class WorkingSessionTracker implements vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  private readonly states = new Map<string, WorkingState>();

  dispose(): void {
    this._onDidChange.dispose();
  }

  update(provider: ProviderId, sessionId: string, state: string | null | undefined): void {
    if (!sessionId) { return; }
    const normalized = normalizeWorkingState(state);
    const key = `${provider}:${sessionId}`;
    if (normalized === 'idle' || normalized === 'unknown') {
      if (this.states.delete(key)) {
        this._onDidChange.fire();
      }
      return;
    }
    if (this.states.get(key) !== normalized) {
      this.states.set(key, normalized);
      this._onDidChange.fire();
    }
  }

  isWorking(provider: ProviderId, sessionId: string): boolean {
    const state = this.states.get(`${provider}:${sessionId}`);
    return state === 'running' || state === 'waiting';
  }
}

function normalizeWorkingState(state: string | null | undefined): WorkingState {
  switch (state) {
    case 'running':
    case 'waiting':
    case 'idle':
    case 'failed':
    case 'review':
      return state;
    case 'waiting_input':
      return 'waiting';
    default:
      return 'unknown';
  }
}
