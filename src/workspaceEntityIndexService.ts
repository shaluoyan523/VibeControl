import * as vscode from 'vscode';
import { SessionIndexService } from './sessionIndexService';
import { NoteRegistry } from './noteRegistry';
import { TaskRegistry } from './taskRegistry';
import { TaskDraftRegistry } from './taskDraftRegistry';
import { TerminalRegistry } from './terminalRegistry';
import {
  NoteSnapshot,
  SessionInteractionSnapshot,
  TaskSnapshot,
  TerminalSnapshot,
  WorkspaceControlState,
  WorkspaceEntity,
  WorkspaceEntityKind,
  WorkspaceEntityStats,
  WorkspaceNoteEntity,
  WorkspaceSessionEntity,
  WorkspaceTaskEntity,
  WorkspaceTerminalEntity,
} from './workspaceEntities';
import { SessionSnapshot } from './types';
import { relationSummary } from './workspaceArtifacts';

export class WorkspaceEntityIndexService implements vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly sessionIndexService: SessionIndexService,
    private readonly terminalRegistry: TerminalRegistry,
    private readonly taskRegistry: TaskRegistry,
    private readonly taskDraftRegistry: TaskDraftRegistry,
    private readonly noteRegistry: NoteRegistry,
  ) {
    this.disposables.push(
      this._onDidChange,
      this.terminalRegistry.onDidChange(() => this._onDidChange.fire()),
      this.taskRegistry.onDidChange(() => this._onDidChange.fire()),
      this.taskDraftRegistry.onDidChange(() => this._onDidChange.fire()),
      this.noteRegistry.onDidChange(() => this._onDidChange.fire()),
    );
  }

  dispose(): void {
    while (this.disposables.length > 0) {
      this.disposables.pop()?.dispose();
    }
  }

  refresh(): void {
    this._onDidChange.fire();
  }

  listEntities(kindFilter: WorkspaceEntityKind | 'all' = 'all'): WorkspaceEntity[] {
    return this.collectEntities()
      .filter((entity) => kindFilter === 'all' || entity.kind === kindFilter)
      .sort((left, right) => right.updatedAt - left.updatedAt);
  }

  searchEntities(query: string, kindFilter: WorkspaceEntityKind | 'all' = 'all'): WorkspaceEntity[] {
    const entities = this.listEntities(kindFilter);
    const normalized = normalizeQuery(query);
    if (!normalized) { return entities; }

    const terms = normalized.split(/\s+/).filter(Boolean);
    return entities
      .map((entity) => ({ entity, score: scoreEntity(entity, terms) }))
      .filter((item) => item.score > 0)
      .sort((left, right) => {
        if (right.score !== left.score) {
          return right.score - left.score;
        }
        return right.entity.updatedAt - left.entity.updatedAt;
      })
      .map((item) => item.entity);
  }

  getStats(entities = this.listEntities()): WorkspaceEntityStats {
    return entities.reduce<WorkspaceEntityStats>((stats, entity) => {
      stats.total++;
      if (entity.kind === 'session') { stats.sessions++; }
      if (entity.kind === 'terminal') { stats.terminals++; }
      if (entity.kind === 'task') { stats.tasks++; }
      if (entity.kind === 'note') { stats.notes++; }
      if (entity.status === 'active' || entity.status === 'pending') { stats.active++; }
      if (entity.status === 'error') { stats.errors++; }
      if (entity.attentionReason !== 'none') { stats.attention++; }
      return stats;
    }, {
      total: 0,
      sessions: 0,
      terminals: 0,
      tasks: 0,
      notes: 0,
      active: 0,
      attention: 0,
      errors: 0,
    });
  }

  getAttentionEntities(limit = 8): WorkspaceEntity[] {
    return this.listEntities()
      .filter((entity) => entity.attentionReason !== 'none')
      .slice(0, limit);
  }

  getEntitiesForState(state: WorkspaceControlState): WorkspaceEntity[] {
    return this.searchEntities(state.query, state.kindFilter);
  }

  listSessionInteractions(limit = Number.POSITIVE_INFINITY): SessionInteractionSnapshot[] {
    const interactions = [
      ...this.taskDraftRegistry.listTasks()
        .map((task) => this.toSessionInteractionFromTask(task))
        .filter((item): item is SessionInteractionSnapshot => item !== null),
      ...this.noteRegistry.listNotes()
        .map((note) => this.toSessionInteractionFromNote(note))
        .filter((item): item is SessionInteractionSnapshot => item !== null),
    ].sort((left, right) => right.updatedAt - left.updatedAt);

    return Number.isFinite(limit) ? interactions.slice(0, limit) : interactions;
  }

  async openEntity(entity: WorkspaceEntity, openSessionInNewTab = false): Promise<void> {
    switch (entity.kind) {
      case 'session':
        await vscode.commands.executeCommand(openSessionInNewTab ? 'vibe-control.openSessionNewTab' : 'vibe-control.openSession', entity.session);
        return;
      case 'terminal':
        this.terminalRegistry.focusTerminal(entity.id);
        return;
      case 'task':
        if (entity.task.taskType === 'draft' && entity.task.absolutePath) {
          await this.taskDraftRegistry.openTask(entity.task.absolutePath);
          return;
        }
        await this.taskRegistry.showTaskLog();
        return;
      case 'note':
        await this.noteRegistry.openNote(entity.note.absolutePath);
        return;
    }
  }

  async performAction(kind: WorkspaceEntityKind, id: string, action: string): Promise<void> {
    const entity = this.findEntity(kind, id);
    if (!entity) { return; }

    switch (action) {
      case 'open':
        await this.openEntity(entity);
        return;
      case 'openNewTab':
        if (entity.kind === 'session') {
          await this.openEntity(entity, true);
        }
        return;
      case 'interrupt':
        if (entity.kind === 'session') {
          await vscode.commands.executeCommand('vibe-control.interruptSession', entity.session);
        }
        return;
      case 'stop':
        if (entity.kind === 'session') {
          await vscode.commands.executeCommand('vibe-control.stopSession', entity.session);
        }
        return;
      case 'focus':
        if (entity.kind === 'terminal') {
          this.terminalRegistry.focusTerminal(entity.id);
        }
        return;
      case 'close':
        if (entity.kind === 'terminal') {
          this.terminalRegistry.closeTerminal(entity.id);
        }
        return;
      case 'createNote':
        if (entity.kind === 'session' || entity.kind === 'terminal' || entity.kind === 'task') {
          await vscode.commands.executeCommand('vibe-control.newNoteFromEntity', entity);
        }
        return;
      case 'rerun':
        if (entity.kind === 'task' && entity.task.taskType === 'runtime') {
          await this.taskRegistry.rerunTask(entity.id);
        }
        return;
      case 'terminate':
        if (entity.kind === 'task' && entity.task.taskType === 'runtime') {
          this.taskRegistry.terminateTask(entity.id);
        }
        return;
      case 'showLog':
        if (entity.kind === 'task' && entity.task.taskType === 'runtime') {
          await this.taskRegistry.showTaskLog();
        }
        return;
      case 'copyPath':
        if (entity.kind === 'note') {
          await vscode.env.clipboard.writeText(entity.note.absolutePath);
          void vscode.window.showInformationMessage(`Copied note path: ${entity.note.absolutePath}`);
          return;
        }
        if (entity.kind === 'task' && entity.task.absolutePath) {
          await vscode.env.clipboard.writeText(entity.task.absolutePath);
          void vscode.window.showInformationMessage(`Copied task path: ${entity.task.absolutePath}`);
        }
        return;
      case 'convertToTask':
        if (entity.kind === 'note') {
          await vscode.commands.executeCommand('vibe-control.convertNoteToTask', entity.note);
        }
        return;
      case 'copyId':
        if (entity.kind === 'session') {
          await vscode.env.clipboard.writeText(entity.session.id);
          void vscode.window.showInformationMessage(`Copied session ID: ${entity.session.id}`);
        }
        return;
    }
  }

  async performSessionInteractionAction(id: string, action: string): Promise<void> {
    const interaction = this.listSessionInteractions().find((item) => item.id === id) || null;
    if (!interaction) {
      return;
    }

    switch (action) {
      case 'openArtifact':
        if (interaction.artifactKind === 'note') {
          await this.noteRegistry.openNote(interaction.artifactPath);
          return;
        }
        await this.taskDraftRegistry.openTask(interaction.artifactPath);
        return;
      case 'openSource':
        await this.openInteractionSession(interaction.sourceSessionId);
        return;
      case 'openTarget':
        await this.openInteractionSession(interaction.targetSessionId);
        return;
      case 'copyPath':
        await vscode.env.clipboard.writeText(interaction.artifactPath);
        void vscode.window.showInformationMessage(`Copied handoff path: ${interaction.artifactPath}`);
        return;
    }
  }

  private findEntity(kind: WorkspaceEntityKind, id: string): WorkspaceEntity | null {
    return this.listEntities(kind).find((entity) => entity.id === id) || null;
  }

  private collectEntities(): WorkspaceEntity[] {
    return [
      ...this.sessionIndexService.listSessions().map((session) => this.toSessionEntity(session)),
      ...this.terminalRegistry.listTerminals().map((terminal) => this.toTerminalEntity(terminal)),
      ...this.taskRegistry.listTasks().map((task) => this.toTaskEntity(task)),
      ...this.taskDraftRegistry.listTasks().map((task) => this.toTaskEntity(task)),
      ...this.noteRegistry.listNotes().map((note) => this.toNoteEntity(note)),
    ];
  }

  private async openInteractionSession(sessionId: string): Promise<void> {
    const session = this.sessionIndexService.listSessions().find((candidate) => candidate.id === sessionId) || null;
    if (!session) {
      return;
    }
    await vscode.commands.executeCommand('vibe-control.openSession', session);
  }

  private toSessionEntity(session: SessionSnapshot): WorkspaceSessionEntity {
    return {
      kind: 'session',
      id: session.id,
      title: session.name,
      description: `${session.providerLabel} · ${session.projectLabel} · ${session.status}`,
      detail: [
        session.cwd,
        session.gitBranch ? `branch:${session.gitBranch}` : '',
        session.resolvedId ? `resolved:${session.resolvedId}` : '',
      ].filter(Boolean).join(' · '),
      updatedAt: session.lastModified,
      status: session.attentionReason === 'pending' ? 'pending' : mapSessionStatus(session.status),
      attentionReason: session.attentionReason,
      searchText: session.searchText,
      icon: session.provider === 'claude' ? 'comment-discussion' : 'sparkle',
      session,
      provider: session.provider,
    };
  }

  private toTerminalEntity(terminal: TerminalSnapshot): WorkspaceTerminalEntity {
    return {
      kind: 'terminal',
      id: terminal.id,
      title: terminal.title,
      description: terminal.commandLine
        ? `Terminal · ${terminal.status} · ${truncateText(terminal.commandLine, 72)}`
        : `Terminal · ${terminal.status}`,
      detail: [
        terminal.cwd,
        terminal.commandLine,
        summarizeTerminalOutput(terminal.recentOutput),
      ].filter(Boolean).join(' · '),
      updatedAt: terminal.updatedAt,
      status: terminal.status,
      attentionReason: terminal.status === 'active' && terminal.isInteractedWith ? 'active_terminal' : 'none',
      searchText: normalizeQuery([
        terminal.title,
        terminal.detail,
        terminal.status,
        terminal.cwd,
        terminal.commandLine,
        terminal.recentOutput,
        terminal.hasShellIntegration ? 'shell-integration' : 'plain-terminal',
      ].filter(Boolean).join(' ')),
      icon: 'terminal',
      terminal,
    };
  }

  private toTaskEntity(task: TaskSnapshot): WorkspaceTaskEntity {
    const relatedDetail = relationSummary(task.related);
    return {
      kind: 'task',
      id: task.id,
      title: task.title,
      description: task.taskType === 'draft'
        ? `Task Draft · ${task.draftStatus || 'todo'}`
        : `Task · ${task.status}`,
      detail: [task.detail, relatedDetail].filter(Boolean).join(' · '),
      updatedAt: task.updatedAt,
      status: task.status,
      attentionReason: task.status === 'error' ? 'error' : 'none',
      searchText: normalizeQuery([
        task.title,
        task.detail,
        task.source,
        task.scope,
        task.status,
        task.requirement,
        task.sourceNotePath,
        task.related.map(item => item.title).join(' '),
      ].filter(Boolean).join(' ')),
      icon: task.taskType === 'draft' ? 'tasklist' : 'checklist',
      task,
    };
  }

  private toNoteEntity(note: NoteSnapshot): WorkspaceNoteEntity {
    const relatedDetail = relationSummary(note.related);
    return {
      kind: 'note',
      id: note.id,
      title: note.title,
      description: note.related.length > 0 ? `Note · ${note.related[0].kind}` : 'Note',
      detail: [note.detail, relatedDetail].filter(Boolean).join(' · '),
      updatedAt: note.updatedAt,
      status: 'idle',
      attentionReason: 'none',
      searchText: normalizeQuery([
        note.title,
        note.detail,
        note.excerpt,
        note.related.map(item => item.title).join(' '),
      ].filter(Boolean).join(' ')),
      icon: 'note',
      note,
    };
  }

  private toSessionInteractionFromTask(task: TaskSnapshot): SessionInteractionSnapshot | null {
    if (task.taskType !== 'draft' || !task.absolutePath) {
      return null;
    }

    return this.toSessionInteraction({
      id: task.id,
      title: task.title,
      artifactKind: 'task',
      artifactPath: task.absolutePath,
      updatedAt: task.updatedAt,
      detail: task.detail,
      related: task.related,
    });
  }

  private toSessionInteractionFromNote(note: NoteSnapshot): SessionInteractionSnapshot | null {
    return this.toSessionInteraction({
      id: note.id,
      title: note.title,
      artifactKind: 'note',
      artifactPath: note.absolutePath,
      updatedAt: note.updatedAt,
      detail: note.detail,
      related: note.related,
    });
  }

  private toSessionInteraction(input: {
    id: string;
    title: string;
    artifactKind: 'task' | 'note';
    artifactPath: string;
    updatedAt: number;
    detail: string;
    related: NoteSnapshot['related'];
  }): SessionInteractionSnapshot | null {
    const sessionRelations = input.related.filter((item) => item.kind === 'session');
    if (sessionRelations.length < 2) {
      return null;
    }

    const source = sessionRelations[0];
    const target = sessionRelations[1];
    if (!source || !target) {
      return null;
    }

    const sourceProviderLabel = providerLabelFromId(source.provider);
    const targetProviderLabel = providerLabelFromId(target.provider);
    return {
      id: input.id,
      title: input.title,
      artifactKind: input.artifactKind,
      artifactPath: input.artifactPath,
      updatedAt: input.updatedAt,
      summary: `${sourceProviderLabel} ${source.title} -> ${targetProviderLabel} ${target.title}`,
      detail: [input.detail, truncateText(input.artifactPath, 120)].filter(Boolean).join(' · '),
      sourceSessionId: source.id,
      sourceSessionTitle: source.title,
      sourceProvider: source.provider,
      targetSessionId: target.id,
      targetSessionTitle: target.title,
      targetProvider: target.provider,
    };
  }
}

function mapSessionStatus(status: SessionSnapshot['status']): 'active' | 'idle' | 'error' | 'pending' {
  switch (status) {
    case 'running':
      return 'active';
    case 'error':
      return 'error';
    case 'not_started':
      return 'pending';
    default:
      return 'idle';
  }
}

function normalizeQuery(value: string): string {
  return value.trim().toLowerCase();
}

function providerLabelFromId(provider: WorkspaceSessionEntity['provider'] | undefined): string {
  if (provider === 'claude') {
    return 'Claude';
  }
  if (provider === 'codex') {
    return 'Codex';
  }
  return 'Session';
}


function truncateText(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 3)}...` : value;
}

function summarizeTerminalOutput(value: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return '';
  }
  return truncateText(normalized, 160);
}

function scoreEntity(entity: WorkspaceEntity, terms: string[]): number {
  let score = 0;
  for (const term of terms) {
    if (!entity.searchText.includes(term)) {
      return 0;
    }
    if (entity.id === term) {
      score += 90;
      continue;
    }
    if (normalizeQuery(entity.title) === term) {
      score += 70;
      continue;
    }
    if (normalizeQuery(entity.title).includes(term)) {
      score += 40;
      continue;
    }
    score += 10;
  }
  if (entity.attentionReason !== 'none') {
    score += 20;
  }
  if (entity.status === 'active') {
    score += 10;
  }
  return score;
}
