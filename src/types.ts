export type ProviderId = 'claude' | 'codex';

export type ConversationStatus = 'running' | 'idle' | 'error' | 'not_started';

export interface ClaudeSession {
  sessionId: string;
  summary: string;
  lastModified: number;
  fileSize: number;
  cwd?: string;
  gitBranch?: string;
  customTitle?: string;
  firstPrompt?: string;
}

export interface ProjectGroup {
  dirName: string;
  sessions: ClaudeSession[];
}

export interface ConversationRecord {
  provider: ProviderId;
  id: string;
  name: string;
  summary: string;
  lastModified: number;
  fileSize: number;
  cwd?: string;
  gitBranch?: string;
  customTitle?: string;
  firstPrompt?: string;
  status: ConversationStatus;
  isPending?: boolean;
}

export type SessionAttentionReason = 'permission' | 'error' | 'pending' | 'none';

export interface SessionSnapshot extends ConversationRecord {
  projectLabel: string;
  providerLabel: string;
  resolvedId?: string;
  model?: string;
  pendingPermissionCount: number;
  attentionReason: SessionAttentionReason;
  isActive: boolean;
  searchText: string;
}

export interface SessionStats {
  total: number;
  running: number;
  idle: number;
  error: number;
  notStarted: number;
  pending: number;
  permissionPending: number;
  active: number;
}

export interface UnifiedProjectGroup {
  key: string;
  label: string;
  cwd?: string;
  conversations: ConversationRecord[];
}
