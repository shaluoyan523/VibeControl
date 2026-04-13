import * as path from 'path';
import { ConversationManager } from './conversationManager';
import { CodexProcessManager } from './codexProcessManager';
import { ProcessManager } from './processManager';
import { ConversationRecord, ProviderId, SessionSnapshot, SessionStats } from './types';
import { WorkingSessionTracker } from './workingSessionTracker';

type RuntimeManagerLike = {
  getModel(sessionId: string): string | undefined;
  getPendingPermissions(sessionId: string): Array<unknown>;
  getResolvedSessionId(sessionId: string): string | undefined;
  getStatus(sessionId: string): 'running' | 'idle' | 'error' | 'not_started';
};

export class SessionIndexService {
  constructor(
    private readonly conversationManager: ConversationManager,
    private readonly claudeProcessManager: ProcessManager,
    private readonly codexProcessManager: CodexProcessManager,
    private readonly workingSessionTracker: WorkingSessionTracker,
  ) {}

  listSessions(): SessionSnapshot[] {
    return this.conversationManager.listConversations()
      .map(conversation => this.toSnapshot(conversation))
      .sort((left, right) => {
        const activityScore = Number(right.isActive) - Number(left.isActive);
        if (activityScore !== 0) { return activityScore; }
        const attentionScore = attentionPriority(right.attentionReason) - attentionPriority(left.attentionReason);
        if (attentionScore !== 0) { return attentionScore; }
        return right.lastModified - left.lastModified;
      });
  }

  searchSessions(query: string): SessionSnapshot[] {
    const normalized = normalizeQuery(query);
    const sessions = this.listSessions();
    if (!normalized) { return sessions; }

    const terms = normalized.split(/\s+/).filter(Boolean);
    return sessions
      .map(session => ({ session, score: scoreSession(session, terms) }))
      .filter(item => item.score > 0)
      .sort((left, right) => {
        if (right.score !== left.score) { return right.score - left.score; }
        return right.session.lastModified - left.session.lastModified;
      })
      .map(item => item.session);
  }

  listActiveSessions(): SessionSnapshot[] {
    return this.listSessions().filter(session => session.isActive);
  }

  listAttentionSessions(): SessionSnapshot[] {
    return this.listSessions().filter(session => session.attentionReason !== 'none');
  }

  getStats(): SessionStats {
    const sessions = this.listSessions();
    return sessions.reduce<SessionStats>((stats, session) => {
      stats.total++;
      if (session.isActive) { stats.active++; }
      if (session.isPending) { stats.pending++; }
      if (session.pendingPermissionCount > 0) { stats.permissionPending++; }
      switch (session.status) {
        case 'running':
          stats.running++;
          break;
        case 'idle':
          stats.idle++;
          break;
        case 'error':
          stats.error++;
          break;
        case 'not_started':
          stats.notStarted++;
          break;
      }
      return stats;
    }, {
      total: 0,
      running: 0,
      idle: 0,
      error: 0,
      notStarted: 0,
      pending: 0,
      permissionPending: 0,
      active: 0,
    });
  }

  private toSnapshot(conversation: ConversationRecord): SessionSnapshot {
    const runtime = this.getRuntime(conversation.provider);
    const pendingPermissionCount = runtime.getPendingPermissions(conversation.id).length;
    const resolvedId = runtime.getResolvedSessionId(conversation.id);
    const status = runtime.getStatus(conversation.id);
    const projectLabel = conversation.cwd ? path.basename(conversation.cwd) || conversation.cwd : 'Unknown Project';
    const providerLabel = conversation.provider === 'claude' ? 'Claude' : 'Codex';
    const attentionReason = pendingPermissionCount > 0
      ? 'permission'
      : conversation.isPending
        ? 'pending'
        : status === 'error'
          ? 'error'
          : 'none';

    return {
      ...conversation,
      status,
      projectLabel,
      providerLabel,
      resolvedId,
      model: runtime.getModel(conversation.id),
      pendingPermissionCount,
      attentionReason,
      isActive: this.workingSessionTracker.isWorking(conversation.provider, conversation.id)
        || status === 'running'
        || pendingPermissionCount > 0,
      searchText: normalizeQuery([
        conversation.name,
        conversation.summary,
        conversation.customTitle,
        conversation.firstPrompt,
        conversation.cwd,
        conversation.gitBranch,
        conversation.id,
        resolvedId,
        providerLabel,
        projectLabel,
      ].filter(Boolean).join(' ')),
    };
  }

  private getRuntime(provider: ProviderId): RuntimeManagerLike {
    return provider === 'codex' ? this.codexProcessManager : this.claudeProcessManager;
  }
}

function normalizeQuery(value: string): string {
  return value.trim().toLowerCase();
}

function attentionPriority(reason: SessionSnapshot['attentionReason']): number {
  switch (reason) {
    case 'permission':
      return 3;
    case 'error':
      return 2;
    case 'pending':
      return 1;
    default:
      return 0;
  }
}

function scoreSession(session: SessionSnapshot, terms: string[]): number {
  let score = 0;
  for (const term of terms) {
    if (!session.searchText.includes(term)) {
      return 0;
    }
    if (session.id === term || session.resolvedId === term) {
      score += 100;
      continue;
    }
    if (normalizeQuery(session.name) === term) {
      score += 80;
      continue;
    }
    if (normalizeQuery(session.name).includes(term)) {
      score += 50;
      continue;
    }
    if ((session.cwd || '').toLowerCase().includes(term)) {
      score += 25;
      continue;
    }
    score += 10;
  }
  if (session.isActive) { score += 15; }
  if (session.pendingPermissionCount > 0) { score += 10; }
  return score;
}
