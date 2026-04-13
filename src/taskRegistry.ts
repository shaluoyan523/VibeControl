import * as vscode from 'vscode';
import { TaskSnapshot } from './workspaceEntities';

type TaskRecord = {
  id: string;
  execution?: vscode.TaskExecution;
  task: vscode.Task;
  processId?: number;
  exitCode?: number;
  updatedAt: number;
  status: 'active' | 'idle' | 'error';
};

const MAX_TASK_HISTORY = 20;

export class TaskRegistry implements vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly executionIds = new Map<vscode.TaskExecution, string>();
  private readonly activeRecords = new Map<string, TaskRecord>();
  private readonly recentRecords = new Map<string, TaskRecord>();
  private nextId = 1;

  constructor() {
    for (const execution of vscode.tasks.taskExecutions) {
      this.ensureRecord(execution);
    }

    this.disposables.push(
      this._onDidChange,
      vscode.tasks.onDidStartTask((event) => {
        this.ensureRecord(event.execution);
        this._onDidChange.fire();
      }),
      vscode.tasks.onDidEndTask((event) => {
        this.finishTask(event.execution);
      }),
      vscode.tasks.onDidStartTaskProcess((event) => {
        const record = this.ensureRecord(event.execution);
        record.processId = event.processId;
        record.updatedAt = Date.now();
        this._onDidChange.fire();
      }),
      vscode.tasks.onDidEndTaskProcess((event) => {
        const id = this.executionIds.get(event.execution);
        if (!id) { return; }
        const record = this.activeRecords.get(id) || this.recentRecords.get(id);
        if (!record) { return; }
        record.exitCode = event.exitCode;
        record.status = typeof event.exitCode === 'number' && event.exitCode !== 0 ? 'error' : 'idle';
        record.updatedAt = Date.now();
        this._onDidChange.fire();
      }),
    );
  }

  dispose(): void {
    while (this.disposables.length > 0) {
      this.disposables.pop()?.dispose();
    }
  }

  listTasks(): TaskSnapshot[] {
    return [...this.activeRecords.values(), ...this.recentRecords.values()]
      .map((record) => this.toSnapshot(record))
      .sort((left, right) => right.updatedAt - left.updatedAt);
  }

  async rerunTask(id: string): Promise<boolean> {
    const record = this.activeRecords.get(id) || this.recentRecords.get(id);
    if (!record) { return false; }
    await vscode.tasks.executeTask(record.task);
    return true;
  }

  terminateTask(id: string): boolean {
    const record = this.activeRecords.get(id);
    if (!record?.execution) { return false; }
    record.execution.terminate();
    return true;
  }

  async showTaskLog(): Promise<void> {
    await vscode.commands.executeCommand('workbench.action.tasks.showLog');
  }

  private ensureRecord(execution: vscode.TaskExecution): TaskRecord {
    const existingId = this.executionIds.get(execution);
    if (existingId) {
      const existingRecord = this.activeRecords.get(existingId) || this.recentRecords.get(existingId);
      if (existingRecord) {
        return existingRecord;
      }
    }

    const id = `task-${this.nextId++}`;
    const record: TaskRecord = {
      id,
      execution,
      task: execution.task,
      updatedAt: Date.now(),
      status: 'active',
    };
    this.executionIds.set(execution, id);
    this.activeRecords.set(id, record);
    return record;
  }

  private finishTask(execution: vscode.TaskExecution): void {
    const id = this.executionIds.get(execution);
    if (!id) { return; }
    const record = this.activeRecords.get(id);
    if (!record) { return; }
    record.execution = undefined;
    record.updatedAt = Date.now();
    this.activeRecords.delete(id);
    this.recentRecords.set(id, record);
    this.trimHistory();
    this._onDidChange.fire();
  }

  private trimHistory(): void {
    const records = Array.from(this.recentRecords.values()).sort((left, right) => right.updatedAt - left.updatedAt);
    for (const record of records.slice(MAX_TASK_HISTORY)) {
      this.recentRecords.delete(record.id);
    }
  }

  private toSnapshot(record: TaskRecord): TaskSnapshot {
    const source = record.task.source;
    const scope = formatTaskScope(record.task.scope);
    const detailParts = [source, scope];
    if (typeof record.processId === 'number') {
      detailParts.push(`pid:${record.processId}`);
    }
    if (typeof record.exitCode === 'number') {
      detailParts.push(`exit:${record.exitCode}`);
    }
    return {
      id: record.id,
      title: record.task.name,
      detail: detailParts.filter(Boolean).join(' · '),
      updatedAt: record.updatedAt,
      status: record.status,
      source,
      scope,
      exitCode: record.exitCode,
      canRerun: true,
      canTerminate: !!record.execution,
      taskType: 'runtime',
      related: [],
    };
  }
}

function formatTaskScope(scope: vscode.TaskScope | vscode.WorkspaceFolder | undefined): string {
  if (!scope) { return 'workspace'; }
  if (scope === vscode.TaskScope.Global) { return 'global'; }
  if (scope === vscode.TaskScope.Workspace) { return 'workspace'; }
  return scope.name;
}
