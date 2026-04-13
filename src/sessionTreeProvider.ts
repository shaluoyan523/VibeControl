import * as path from 'path';
import * as vscode from 'vscode';
import { ConversationRecord } from './types';
import { ConversationManager } from './conversationManager';
import { NoteRegistry } from './noteRegistry';
import { NoteSnapshot } from './workspaceEntities';

type SidebarProjectGroup = {
  key: string;
  label: string;
  cwd?: string;
  conversations: ConversationRecord[];
  notes: NoteSnapshot[];
  lastModified: number;
};

type TreeItem = ProjectItem | ConversationItem | NoteItem;

class ProjectItem extends vscode.TreeItem {
  constructor(public readonly group: SidebarProjectGroup) {
    super(path.basename(group.label) || group.label, vscode.TreeItemCollapsibleState.Expanded);
    const sessionCount = group.conversations.length;
    const noteCount = group.notes.length;
    const parts: string[] = [];
    if (sessionCount > 0) {
      parts.push(`${sessionCount} session${sessionCount !== 1 ? 's' : ''}`);
    }
    if (noteCount > 0) {
      parts.push(`${noteCount} note${noteCount !== 1 ? 's' : ''}`);
    }
    this.description = parts.join(' • ');
    this.iconPath = new vscode.ThemeIcon('folder');
    this.contextValue = 'project';
    this.tooltip = group.cwd || group.label;
  }
}

class ConversationItem extends vscode.TreeItem {
  constructor(public readonly conversation: ConversationRecord, extensionPath: string) {
    super(conversation.name, vscode.TreeItemCollapsibleState.None);

    const date = new Date(conversation.lastModified);
    const relTime = formatRelativeTime(date);
    this.description = `${providerLabel(conversation.provider)} • ${relTime}`;

    const lines = [
      `Provider: ${providerLabel(conversation.provider)}`,
      conversation.customTitle ? `Title: ${conversation.customTitle}` : '',
      conversation.firstPrompt ? `First: ${conversation.firstPrompt}` : '',
      conversation.cwd ? `Path: ${conversation.cwd}` : '',
      conversation.gitBranch ? `Branch: ${conversation.gitBranch}` : '',
      `Updated: ${date.toLocaleString()}`,
      `Size: ${formatBytes(conversation.fileSize)}`,
      `ID: ${conversation.id}`,
    ].filter(Boolean);
    this.tooltip = lines.join('\n');

    const iconFile = providerIcon(conversation.provider);
    this.iconPath = vscode.Uri.file(path.join(extensionPath, 'resources', iconFile));
    this.contextValue = 'session';
    this.command = {
      command: 'vibe-control.activateSession',
      title: 'Activate Session',
      arguments: [conversation],
    };
  }
}

class NoteItem extends vscode.TreeItem {
  constructor(public readonly note: NoteSnapshot) {
    super(note.title, vscode.TreeItemCollapsibleState.None);

    const date = new Date(note.updatedAt);
    const relTime = formatRelativeTime(date);
    this.description = `Note • ${relTime}`;
    this.iconPath = new vscode.ThemeIcon('note');
    this.contextValue = 'note';
    this.tooltip = [
      `Path: ${note.relativePath}`,
      `Updated: ${date.toLocaleString()}`,
      note.related.length > 0 ? `Related: ${note.related.map(item => `${item.kind}:${item.title}`).join(' • ')}` : '',
      note.excerpt ? `Excerpt: ${note.excerpt}` : '',
    ].filter(Boolean).join('\n');
    this.command = {
      command: 'vibe-control.openNote',
      title: 'Open Note',
      arguments: [note],
    };
  }
}

export class SessionTreeProvider implements vscode.TreeDataProvider<TreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<TreeItem | undefined | void>();
  private pausedRefreshes = 0;
  private pendingRefresh = false;
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(
    private conversationManager: ConversationManager,
    private noteRegistry: NoteRegistry,
    private extensionPath: string,
  ) {
    conversationManager.onDidChange(() => this.requestRefresh());
    noteRegistry.onDidChange(() => this.requestRefresh());
  }

  refresh(): void {
    this.requestRefresh();
  }

  async runWithRefreshPaused<T>(callback: () => Promise<T>): Promise<T> {
    this.pausedRefreshes++;
    try {
      return await callback();
    } finally {
      this.pausedRefreshes = Math.max(0, this.pausedRefreshes - 1);
      if (this.pausedRefreshes === 0 && this.pendingRefresh) {
        this.pendingRefresh = false;
        this._onDidChangeTreeData.fire();
      }
    }
  }

  getTreeItem(element: TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: TreeItem): TreeItem[] {
    if (!element) {
      return this.buildProjectGroups().map(group => new ProjectItem(group));
    }

    if (element instanceof ProjectItem) {
      const children: Array<{ updatedAt: number; item: TreeItem }> = [
        ...element.group.conversations.map(conversation => ({
          updatedAt: conversation.lastModified,
          item: new ConversationItem(conversation, this.extensionPath) as TreeItem,
        })),
        ...element.group.notes.map(note => ({
          updatedAt: note.updatedAt,
          item: new NoteItem(note) as TreeItem,
        })),
      ];

      return children
        .sort((left, right) => right.updatedAt - left.updatedAt)
        .map(entry => entry.item);
    }

    return [];
  }

  private buildProjectGroups(): SidebarProjectGroup[] {
    const groups = new Map<string, SidebarProjectGroup>();

    for (const group of this.conversationManager.getProjectGroups()) {
      groups.set(group.key, {
        key: group.key,
        label: group.label,
        cwd: group.cwd,
        conversations: [...group.conversations],
        notes: [],
        lastModified: group.conversations[0]?.lastModified || 0,
      });
    }

    for (const note of this.noteRegistry.listNotes()) {
      const cwd = resolveNoteWorkspacePath(note.absolutePath);
      const key = cwd || `notes:${note.absolutePath}`;
      const label = cwd || path.dirname(note.absolutePath);
      const existing = groups.get(key);
      if (existing) {
        existing.notes.push(note);
        existing.lastModified = Math.max(existing.lastModified, note.updatedAt);
        continue;
      }
      groups.set(key, {
        key,
        label,
        cwd,
        conversations: [],
        notes: [note],
        lastModified: note.updatedAt,
      });
    }

    return Array.from(groups.values())
      .sort((left, right) => right.lastModified - left.lastModified);
  }

  private requestRefresh(): void {
    if (this.pausedRefreshes > 0) {
      this.pendingRefresh = true;
      return;
    }
    this._onDidChangeTreeData.fire();
  }
}

function resolveNoteWorkspacePath(absolutePath: string): string | undefined {
  const marker = `${path.sep}.vibe-control${path.sep}notes`;
  const index = absolutePath.indexOf(marker);
  if (index < 0) { return undefined; }
  return absolutePath.slice(0, index);
}

function providerLabel(provider: ConversationRecord['provider']): string {
  switch (provider) {
    case 'claude':
      return 'Claude';
    case 'codex':
      return 'Codex';
    default:
      return provider;
  }
}

function providerIcon(provider: ConversationRecord['provider']): string {
  switch (provider) {
    case 'claude':
      return 'claude-logo.svg';
    case 'codex':
      return 'openai-logo.svg';
    default:
      return 'icon.svg';
  }
}

function formatRelativeTime(date: Date): string {
  const now = Date.now();
  const diffMs = now - date.getTime();
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) { return 'just now'; }
  if (minutes < 60) { return `${minutes}m ago`; }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) { return `${hours}h ago`; }
  const days = Math.floor(hours / 24);
  if (days < 7) { return `${days}d ago`; }
  return date.toLocaleDateString();
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) { return `${bytes} B`; }
  if (bytes < 1048576) { return `${(bytes / 1024).toFixed(1)} KB`; }
  return `${(bytes / 1048576).toFixed(1)} MB`; }
