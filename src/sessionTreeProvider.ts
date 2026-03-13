import * as vscode from 'vscode';
import { ClaudeSession, ProjectGroup } from './types';
import { SessionManager } from './sessionManager';

type TreeItem = ProjectItem | SessionItem;

class ProjectItem extends vscode.TreeItem {
  constructor(public readonly group: ProjectGroup) {
    super(group.dirName, vscode.TreeItemCollapsibleState.Expanded);
    const count = group.sessions.length;
    this.description = `${count} session${count !== 1 ? 's' : ''}`;
    this.iconPath = new vscode.ThemeIcon('folder');
    this.contextValue = 'project';
    // Show the resolved cwd from the most recent session if available
    const recentCwd = group.sessions[0]?.cwd;
    this.tooltip = recentCwd || group.dirName;
  }
}

class SessionItem extends vscode.TreeItem {
  constructor(
    public readonly session: ClaudeSession,
    public readonly projectDirName: string,
  ) {
    // Use customTitle or truncated summary as label
    const label = session.customTitle || truncate(session.summary, 60);
    super(label, vscode.TreeItemCollapsibleState.None);

    const date = new Date(session.lastModified);
    const relTime = formatRelativeTime(date);
    this.description = relTime;

    const lines = [
      session.customTitle ? `Title: ${session.customTitle}` : '',
      session.firstPrompt ? `First: ${session.firstPrompt}` : '',
      session.cwd ? `Path: ${session.cwd}` : '',
      session.gitBranch ? `Branch: ${session.gitBranch}` : '',
      `Updated: ${date.toLocaleString()}`,
      `Size: ${formatBytes(session.fileSize)}`,
      `ID: ${session.sessionId}`,
    ].filter(Boolean);
    this.tooltip = lines.join('\n');

    this.iconPath = new vscode.ThemeIcon('comment-discussion');
    this.contextValue = 'session';

    // Click → open/resume this session
    this.command = {
      command: 'vibe-control.openSession',
      title: 'Open Session',
      arguments: [session.sessionId, session.cwd],
    };
  }
}

export class SessionTreeProvider implements vscode.TreeDataProvider<TreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<TreeItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private sessionManager: SessionManager) {
    sessionManager.onDidChange(() => this._onDidChangeTreeData.fire());
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: TreeItem): TreeItem[] {
    if (!element) {
      const groups = this.sessionManager.getProjectGroups();
      if (groups.length === 0) { return []; }
      return groups.map(g => new ProjectItem(g));
    }

    if (element instanceof ProjectItem) {
      return element.group.sessions.map(s =>
        new SessionItem(s, element.group.dirName),
      );
    }

    return [];
  }
}

function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) { return s; }
  return s.slice(0, maxLen - 3) + '...';
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
  return `${(bytes / 1048576).toFixed(1)} MB`;
}
