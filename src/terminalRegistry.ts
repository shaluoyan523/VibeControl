import * as vscode from 'vscode';
import { TerminalSnapshot } from './workspaceEntities';

type TerminalRecord = {
  id: string;
  terminal: vscode.Terminal;
  processId?: number;
  updatedAt: number;
  commandLine?: string;
  cwd?: string;
  recentOutput: string;
  hasShellIntegration: boolean;
  commandExitCode?: number;
  outputGeneration: number;
};

const MAX_CLOSED_TERMINALS = 12;
const MAX_OUTPUT_CHARS = 6000;

export class TerminalRegistry implements vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly terminalIds = new Map<vscode.Terminal, string>();
  private readonly openRecords = new Map<string, TerminalRecord>();
  private readonly closedSnapshots: TerminalSnapshot[] = [];
  private nextId = 1;
  private changeTimer: NodeJS.Timeout | null = null;

  constructor() {
    for (const terminal of vscode.window.terminals) {
      this.trackTerminal(terminal);
    }

    this.disposables.push(
      this._onDidChange,
      vscode.window.onDidOpenTerminal((terminal) => {
        this.trackTerminal(terminal);
        this.fireSoon();
      }),
      vscode.window.onDidCloseTerminal((terminal) => {
        this.handleClosedTerminal(terminal);
      }),
      vscode.window.onDidChangeTerminalState((terminal) => {
        if (!this.terminalIds.has(terminal)) {
          this.trackTerminal(terminal);
        }
        const record = this.getRecordForTerminal(terminal);
        if (record) {
          record.updatedAt = Date.now();
        }
        this.fireSoon();
      }),
      vscode.window.onDidStartTerminalShellExecution((event) => {
        this.handleShellExecutionStart(event);
      }),
      vscode.window.onDidEndTerminalShellExecution((event) => {
        this.handleShellExecutionEnd(event);
      }),
    );
  }

  dispose(): void {
    if (this.changeTimer) {
      clearTimeout(this.changeTimer);
      this.changeTimer = null;
    }
    while (this.disposables.length > 0) {
      this.disposables.pop()?.dispose();
    }
  }

  listTerminals(): TerminalSnapshot[] {
    const openSnapshots = Array.from(this.openRecords.values()).map((record) => this.toSnapshot(record));
    return [...openSnapshots, ...this.closedSnapshots]
      .sort((left, right) => right.updatedAt - left.updatedAt);
  }

  focusTerminal(id: string): boolean {
    const record = this.openRecords.get(id);
    if (!record) { return false; }
    record.terminal.show();
    return true;
  }

  closeTerminal(id: string): boolean {
    const record = this.openRecords.get(id);
    if (!record) { return false; }
    record.terminal.dispose();
    return true;
  }

  getSnapshotForTerminal(terminal: vscode.Terminal): TerminalSnapshot | null {
    const record = this.getRecordForTerminal(terminal);
    return record ? this.toSnapshot(record) : null;
  }

  private trackTerminal(terminal: vscode.Terminal): void {
    if (this.terminalIds.has(terminal)) { return; }
    const id = `terminal-${this.nextId++}`;
    const record: TerminalRecord = {
      id,
      terminal,
      updatedAt: Date.now(),
      recentOutput: '',
      hasShellIntegration: false,
      outputGeneration: 0,
    };
    this.terminalIds.set(terminal, id);
    this.openRecords.set(id, record);
    void terminal.processId.then((processId) => {
      const activeRecord = this.openRecords.get(id);
      if (!activeRecord) { return; }
      activeRecord.processId = processId;
      activeRecord.updatedAt = Date.now();
      this.fireSoon();
    });
  }

  private handleClosedTerminal(terminal: vscode.Terminal): void {
    const id = this.terminalIds.get(terminal);
    if (!id) { return; }
    const record = this.openRecords.get(id) || this.createDetachedRecord(id, terminal);
    this.openRecords.delete(id);
    this.terminalIds.delete(terminal);
    record.updatedAt = Date.now();
    this.closedSnapshots.unshift(this.toSnapshot(record, true));
    if (this.closedSnapshots.length > MAX_CLOSED_TERMINALS) {
      this.closedSnapshots.length = MAX_CLOSED_TERMINALS;
    }
    this.fireSoon();
  }

  private handleShellExecutionStart(event: vscode.TerminalShellExecutionStartEvent): void {
    if (!this.terminalIds.has(event.terminal)) {
      this.trackTerminal(event.terminal);
    }
    const record = this.getRecordForTerminal(event.terminal);
    if (!record) { return; }
    record.updatedAt = Date.now();
    record.hasShellIntegration = true;
    record.commandLine = normalizeLine(event.execution.commandLine.value);
    record.cwd = event.execution.cwd?.fsPath;
    record.commandExitCode = undefined;
    record.recentOutput = '';
    record.outputGeneration += 1;
    const generation = record.outputGeneration;
    this.fireSoon();
    void this.consumeExecutionOutput(record.id, generation, event.execution);
  }

  private handleShellExecutionEnd(event: vscode.TerminalShellExecutionEndEvent): void {
    const record = this.getRecordForTerminal(event.terminal);
    if (!record) { return; }
    record.updatedAt = Date.now();
    record.hasShellIntegration = true;
    record.commandExitCode = event.exitCode;
    if (!record.commandLine) {
      record.commandLine = normalizeLine(event.execution.commandLine.value);
    }
    if (!record.cwd) {
      record.cwd = event.execution.cwd?.fsPath;
    }
    this.fireSoon();
  }

  private async consumeExecutionOutput(recordId: string, generation: number, execution: vscode.TerminalShellExecution): Promise<void> {
    try {
      for await (const chunk of execution.read()) {
        const record = this.openRecords.get(recordId);
        if (!record || generation != record.outputGeneration) {
          return;
        }
        const cleaned = stripAnsi(chunk).replace(/\r/g, '');
        if (!cleaned) { continue; }
        record.recentOutput = appendOutput(record.recentOutput, cleaned);
        record.updatedAt = Date.now();
        this.fireSoon();
      }
    } catch {
      // Ignore shell integration read errors and keep the latest captured output.
    }
  }

  private getRecordForTerminal(terminal: vscode.Terminal): TerminalRecord | null {
    const id = this.terminalIds.get(terminal);
    if (!id) { return null; }
    return this.openRecords.get(id) || null;
  }

  private createDetachedRecord(id: string, terminal: vscode.Terminal): TerminalRecord {
    return {
      id,
      terminal,
      updatedAt: Date.now(),
      recentOutput: '',
      hasShellIntegration: false,
      outputGeneration: 0,
    };
  }

  private toSnapshot(record: TerminalRecord, isClosed = false): TerminalSnapshot {
    const exitStatus = record.terminal.exitStatus?.code;
    const interacted = record.terminal.state.isInteractedWith;
    const parts: string[] = [];
    if (typeof record.processId === 'number') {
      parts.push(`pid:${record.processId}`);
    }
    parts.push(isClosed ? 'closed' : 'open');
    if (record.cwd) {
      parts.push(record.cwd);
    }
    if (record.commandLine) {
      parts.push(record.commandLine);
    }
    if (interacted) {
      parts.push('interacted');
    }
    if (typeof record.commandExitCode === 'number') {
      parts.push(`cmd-exit:${record.commandExitCode}`);
    }
    if (typeof exitStatus === 'number') {
      parts.push(`term-exit:${exitStatus}`);
    }
    return {
      id: record.id,
      title: record.terminal.name,
      detail: parts.join(' · '),
      status: isClosed ? 'idle' : 'active',
      updatedAt: record.updatedAt,
      isInteractedWith: interacted,
      exitStatus,
      cwd: record.cwd,
      commandLine: record.commandLine,
      commandExitCode: record.commandExitCode,
      recentOutput: record.recentOutput,
      hasShellIntegration: record.hasShellIntegration,
    };
  }

  private fireSoon(): void {
    if (this.changeTimer) { return; }
    this.changeTimer = setTimeout(() => {
      this.changeTimer = null;
      this._onDidChange.fire();
    }, 120);
  }
}

function normalizeLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function appendOutput(previous: string, chunk: string): string {
  const combined = `${previous}${chunk}`;
  if (combined.length <= MAX_OUTPUT_CHARS) {
    return combined;
  }
  return combined.slice(combined.length - MAX_OUTPUT_CHARS);
}

function stripAnsi(value: string): string {
  return value.replace(/\u001B\[[0-9;?]*[ -\/]*[@-~]/g, '');
}
