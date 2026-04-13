import * as fs from 'fs';
import * as path from 'path';
import { CodexProcessManager } from './codexProcessManager';
import { HttpConversationRegistry } from './httpRuntime';
import { ProcessManager } from './processManager';
import { extractLastAssistantMessage } from './sessionMessageExtractor';
import { SseCaptureResponse } from './sseCaptureResponse';
import { ConversationRecord, ProviderId } from './types';
import {
  buildWorkspaceArtifact,
  createRelatedEntity,
  WorkspaceArtifactMeta,
  WorkspaceNoteMeta,
  WorkspaceTaskDraftMeta,
} from './workspaceArtifacts';
import { WorkspaceRelatedEntity } from './workspaceEntities';

export type SessionHandoffArtifactKind = 'task-draft' | 'note';

export interface CreateSessionHandoffInput {
  sourceProvider: ProviderId;
  sourceSessionId: string;
  targetProvider?: ProviderId;
  targetSessionId?: string;
  artifactKind?: SessionHandoffArtifactKind;
  title?: string;
  instructions?: string;
  basePath?: string;
  relayToTarget?: boolean;
}

export interface SessionHandoffResult {
  artifactKind: SessionHandoffArtifactKind;
  artifactPath: string;
  artifactTitle: string;
  relayPrompt: string;
  relayStarted: boolean;
  sourceMessage: string;
  sourceProvider: ProviderId;
  sourceSessionId: string;
  targetProvider: ProviderId | null;
  targetSessionId: string | null;
}

type ResolvedConversation = {
  conversation: ConversationRecord;
  runtimeSessionId: string;
};

export class SessionHandoffService {
  constructor(
    private readonly conversationRegistry: Pick<
      HttpConversationRegistry,
      'getConversation' | 'getConversationById' | 'getConversationMessages' | 'refresh'
    >,
    private readonly claudeProcessManager: ProcessManager,
    private readonly codexProcessManager: CodexProcessManager,
  ) {}

  async createHandoff(input: CreateSessionHandoffInput): Promise<SessionHandoffResult> {
    const sourceProvider = input.sourceProvider;
    const sourceSessionId = input.sourceSessionId.trim();
    if (!sourceSessionId) {
      throw new Error('sourceSessionId is required');
    }

    const source = this.resolveConversation(sourceProvider, sourceSessionId);
    if (!source) {
      throw new Error(`Source session not found: ${sourceProvider}:${sourceSessionId}`);
    }

    const inferredTargetProvider = input.targetProvider
      || (
        input.targetSessionId
          ? this.conversationRegistry.getConversationById(input.targetSessionId.trim())?.provider
          : undefined
      );
    const target = input.targetSessionId && inferredTargetProvider
      ? this.resolveConversation(inferredTargetProvider, input.targetSessionId.trim())
      : null;
    const relayToTarget = input.relayToTarget === true;

    if (relayToTarget && !target) {
      throw new Error('relayToTarget requires a resolvable target session');
    }

    if (
      relayToTarget
      && target
      && target.conversation.provider === source.conversation.provider
      && target.runtimeSessionId === source.runtimeSessionId
    ) {
      throw new Error('Source and target sessions must be different');
    }

    const messages = this.conversationRegistry.getConversationMessages(
      sourceProvider,
      source.conversation.id,
    );
    const sourceMessage = extractLastAssistantMessage(sourceProvider, messages)
      || normalizeOptionalText(source.conversation.summary);
    if (!sourceMessage) {
      throw new Error('No assistant output is available to hand off yet');
    }

    const artifactKind = input.artifactKind || 'task-draft';
    const artifactTitle = normalizeOptionalText(input.title)
      || `${source.conversation.name} handoff`;
    const instructions = normalizeOptionalText(input.instructions);
    const basePath = this.resolveBasePath(
      input.basePath,
      source.conversation,
      target ? target.conversation : null,
    );
    if (!basePath) {
      throw new Error('Unable to resolve a project path for the handoff artifact');
    }

    const artifactPath = this.writeArtifact({
      artifactKind,
      artifactTitle,
      basePath,
      source: source.conversation,
      target: target?.conversation || null,
      sourceMessage,
      instructions,
    });
    this.conversationRegistry.refresh();

    const relayPrompt = this.buildRelayPrompt({
      artifactPath,
      source: source.conversation,
      instructions,
    });

    if (relayToTarget && target) {
      this.startRelayToTarget({
        target,
        relayPrompt,
      });
    }

    return {
      artifactKind,
      artifactPath,
      artifactTitle,
      relayPrompt,
      relayStarted: relayToTarget && !!target,
      sourceMessage,
      sourceProvider,
      sourceSessionId: source.runtimeSessionId,
      targetProvider: target?.conversation.provider || null,
      targetSessionId: target?.runtimeSessionId || null,
    };
  }

  private resolveConversation(
    provider: ProviderId,
    sessionId: string,
  ): ResolvedConversation | null {
    const direct = this.conversationRegistry.getConversation(provider, sessionId);
    if (direct) {
      return { conversation: direct, runtimeSessionId: sessionId };
    }

    const resolvedSessionId = this.getRuntime(provider).getResolvedSessionId(sessionId);
    if (!resolvedSessionId) {
      return null;
    }

    const resolvedConversation = this.conversationRegistry.getConversation(provider, resolvedSessionId);
    if (!resolvedConversation) {
      return null;
    }

    return {
      conversation: resolvedConversation,
      runtimeSessionId: sessionId,
    };
  }

  private resolveBasePath(
    preferredBasePath: string | undefined,
    source: ConversationRecord,
    target: ConversationRecord | null,
  ): string | null {
    const candidates = [
      preferredBasePath,
      target?.cwd,
      source.cwd,
    ];

    for (const candidate of candidates) {
      const normalized = normalizeProjectPath(candidate);
      if (normalized) {
        return normalized;
      }
    }

    return null;
  }

  private writeArtifact(options: {
    artifactKind: SessionHandoffArtifactKind;
    artifactTitle: string;
    basePath: string;
    source: ConversationRecord;
    target: ConversationRecord | null;
    sourceMessage: string;
    instructions: string | null;
  }): string {
    const related = this.buildRelatedEntities(options.source, options.target);
    const meta = this.buildArtifactMeta(options.artifactKind, options.artifactTitle, related);
    const body = this.buildArtifactBody(options);
    const dirPath = path.join(
      options.basePath,
      '.vibe-control',
      options.artifactKind === 'note' ? 'notes' : 'tasks',
    );
    fs.mkdirSync(dirPath, { recursive: true });

    const filePath = path.join(
      dirPath,
      `${formatFileTimestamp(new Date())}-${slugify(options.artifactTitle) || options.artifactKind}.md`,
    );
    fs.writeFileSync(filePath, buildWorkspaceArtifact(meta, body), 'utf-8');
    return filePath;
  }

  private buildRelatedEntities(
    source: ConversationRecord,
    target: ConversationRecord | null,
  ): WorkspaceRelatedEntity[] {
    const related = [
      createRelatedEntity({
        kind: 'session',
        id: source.id,
        title: source.name,
        description: source.cwd,
        provider: source.provider,
      }),
    ];

    if (target) {
      related.push(createRelatedEntity({
        kind: 'session',
        id: target.id,
        title: target.name,
        description: target.cwd,
        provider: target.provider,
      }));
    }

    return related;
  }

  private buildArtifactMeta(
    artifactKind: SessionHandoffArtifactKind,
    title: string,
    related: WorkspaceRelatedEntity[],
  ): WorkspaceArtifactMeta {
    if (artifactKind === 'note') {
      const noteMeta: WorkspaceNoteMeta = {
        kind: 'note',
        title,
        related,
        template: 'capture',
        source: 'session-handoff',
      };
      return noteMeta;
    }

    const taskMeta: WorkspaceTaskDraftMeta = {
      kind: 'task-draft',
      title,
      related,
      draftStatus: 'todo',
    };
    return taskMeta;
  }

  private buildArtifactBody(options: {
    artifactKind: SessionHandoffArtifactKind;
    artifactTitle: string;
    source: ConversationRecord;
    target: ConversationRecord | null;
    sourceMessage: string;
    instructions: string | null;
  }): string {
    const createdAt = new Date().toISOString();
    const sourceProviderLabel = providerDisplayName(options.source.provider);
    const targetProviderLabel = options.target ? providerDisplayName(options.target.provider) : null;
    const header = options.artifactKind === 'note' ? '## Handoff Context' : '## Task Requirement';
    const instructionText = options.instructions
      || 'Continue from the source session output. Treat the source message below as the handoff context.';

    return `# ${options.artifactTitle}

Created: ${createdAt}

${header}
- Source Provider: ${sourceProviderLabel}
- Source Session: ${options.source.name}
- Source Session ID: ${options.source.id}
${options.source.cwd ? `- Source Path: ${options.source.cwd}` : ''}
${options.target ? `- Target Provider: ${targetProviderLabel}` : ''}
${options.target ? `- Target Session: ${options.target.name}` : ''}
${options.target ? `- Target Session ID: ${options.target.id}` : ''}
${options.target?.cwd ? `- Target Path: ${options.target.cwd}` : ''}

## Instructions
${instructionText}

## Source Session Output

\`\`\`text
${options.sourceMessage}
\`\`\`
`;
  }

  private buildRelayPrompt(options: {
    artifactPath: string;
    source: ConversationRecord;
    instructions: string | null;
  }): string {
    const instructionText = options.instructions
      ? `Additional instructions: ${options.instructions}`
      : 'Read the handoff artifact first, then continue the work from there.';

    return [
      `Continue work handed off from the ${providerDisplayName(options.source.provider)} session "${options.source.name}".`,
      `The handoff artifact is at: ${options.artifactPath}`,
      instructionText,
    ].join('\n');
  }

  private startRelayToTarget(options: {
    target: ResolvedConversation;
    relayPrompt: string;
  }): void {
    const runtime = this.getRuntime(options.target.conversation.provider);
    const cwd = options.target.conversation.cwd || process.cwd();
    const model = runtime.getModel(options.target.runtimeSessionId)
      || (options.target.conversation.provider === 'claude' ? 'sonnet' : undefined);
    const capture = new SseCaptureResponse();
    if (options.target.conversation.provider === 'claude') {
      this.claudeProcessManager.sendMessage(
        options.target.runtimeSessionId,
        options.relayPrompt,
        model || 'sonnet',
        cwd,
        capture.asServerResponse(),
      );
      return;
    }

    this.codexProcessManager.sendMessage(
      options.target.runtimeSessionId,
      options.relayPrompt,
      model,
      cwd,
      capture.asServerResponse(),
    );
  }

  private getRuntime(provider: ProviderId): ProcessManager | CodexProcessManager {
    return provider === 'codex' ? this.codexProcessManager : this.claudeProcessManager;
  }
}

function normalizeOptionalText(value: string | undefined | null): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function normalizeProjectPath(projectPath?: string | null): string | null {
  if (!projectPath || projectPath.trim().length === 0) {
    return null;
  }

  try {
    return fs.realpathSync(projectPath);
  } catch {
    return path.resolve(projectPath);
  }
}

function formatFileTimestamp(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hour = String(date.getHours()).padStart(2, '0');
  const minute = String(date.getMinutes()).padStart(2, '0');
  const second = String(date.getSeconds()).padStart(2, '0');
  return `${year}${month}${day}-${hour}${minute}${second}`;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function providerDisplayName(provider: ProviderId): string {
  return provider === 'claude' ? 'Claude Code' : 'Codex';
}
