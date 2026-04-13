import { ProviderId, SessionAttentionReason, SessionSnapshot } from './types';

export type WorkspaceEntityKind = 'session' | 'terminal' | 'task' | 'note';

export type WorkspaceEntityStatus = 'active' | 'idle' | 'error' | 'pending';

export type WorkspaceEntityAttention = SessionAttentionReason | 'active_terminal';

export type WorkspaceReferenceKind = WorkspaceEntityKind | 'document';

export interface WorkspaceRelatedEntity {
  kind: WorkspaceReferenceKind;
  id: string;
  title: string;
  description?: string;
  provider?: ProviderId;
  absolutePath?: string;
}

interface WorkspaceEntityBase {
  kind: WorkspaceEntityKind;
  id: string;
  title: string;
  description: string;
  detail: string;
  updatedAt: number;
  status: WorkspaceEntityStatus;
  attentionReason: WorkspaceEntityAttention | 'none';
  searchText: string;
  icon: string;
}

export interface WorkspaceSessionEntity extends WorkspaceEntityBase {
  kind: 'session';
  session: SessionSnapshot;
  provider: ProviderId;
}

export interface TerminalSnapshot {
  id: string;
  title: string;
  detail: string;
  status: 'active' | 'idle';
  updatedAt: number;
  isInteractedWith: boolean;
  exitStatus?: number;
  cwd?: string;
  commandLine?: string;
  commandExitCode?: number;
  recentOutput: string;
  hasShellIntegration: boolean;
}

export interface WorkspaceTerminalEntity extends WorkspaceEntityBase {
  kind: 'terminal';
  terminal: TerminalSnapshot;
}

export interface TaskSnapshot {
  id: string;
  title: string;
  detail: string;
  updatedAt: number;
  status: 'active' | 'idle' | 'error';
  source: string;
  scope: string;
  exitCode?: number;
  canRerun: boolean;
  canTerminate: boolean;
  taskType: 'runtime' | 'draft';
  absolutePath?: string;
  sourceNotePath?: string;
  requirement?: string;
  draftStatus?: 'todo' | 'doing' | 'done';
  related: WorkspaceRelatedEntity[];
}

export interface WorkspaceTaskEntity extends WorkspaceEntityBase {
  kind: 'task';
  task: TaskSnapshot;
}

export interface NoteSnapshot {
  id: string;
  title: string;
  detail: string;
  excerpt: string;
  updatedAt: number;
  absolutePath: string;
  relativePath: string;
  related: WorkspaceRelatedEntity[];
}

export interface WorkspaceNoteEntity extends WorkspaceEntityBase {
  kind: 'note';
  note: NoteSnapshot;
}

export interface SessionInteractionSnapshot {
  id: string;
  title: string;
  artifactKind: 'task' | 'note';
  artifactPath: string;
  updatedAt: number;
  summary: string;
  detail: string;
  sourceSessionId: string;
  sourceSessionTitle: string;
  sourceProvider?: ProviderId;
  targetSessionId: string;
  targetSessionTitle: string;
  targetProvider?: ProviderId;
}

export type WorkspaceEntity =
  | WorkspaceSessionEntity
  | WorkspaceTerminalEntity
  | WorkspaceTaskEntity
  | WorkspaceNoteEntity;

export interface WorkspaceEntityStats {
  total: number;
  sessions: number;
  terminals: number;
  tasks: number;
  notes: number;
  active: number;
  attention: number;
  errors: number;
}

export interface WorkspaceControlState {
  query: string;
  kindFilter: WorkspaceEntityKind | 'all';
}

export function defaultWorkspaceControlState(): WorkspaceControlState {
  return {
    query: '',
    kindFilter: 'all',
  };
}
