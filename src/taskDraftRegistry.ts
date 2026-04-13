import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { TaskSnapshot } from './workspaceEntities';
import { parseWorkspaceArtifact, WorkspaceTaskDraftMeta } from './workspaceArtifacts';

export class TaskDraftRegistry implements vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly watcher: vscode.FileSystemWatcher;

  constructor(
    private readonly extraRootPathsProvider: (() => string[]) | null = null,
  ) {
    this.watcher = vscode.workspace.createFileSystemWatcher('**/.vibe-control/tasks/**/*.md');
    this.disposables.push(
      this._onDidChange,
      this.watcher,
      this.watcher.onDidCreate(() => this._onDidChange.fire()),
      this.watcher.onDidChange(() => this._onDidChange.fire()),
      this.watcher.onDidDelete(() => this._onDidChange.fire()),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this._onDidChange.fire()),
    );
  }

  dispose(): void {
    while (this.disposables.length > 0) {
      this.disposables.pop()?.dispose();
    }
  }

  listTasks(): TaskSnapshot[] {
    const tasks: TaskSnapshot[] = [];
    for (const rootPath of this.collectRootPaths()) {
      const tasksDir = path.join(rootPath, '.vibe-control', 'tasks');
      if (!fs.existsSync(tasksDir) || !fs.statSync(tasksDir).isDirectory()) {
        continue;
      }
      for (const filePath of collectMarkdownFiles(tasksDir)) {
        try {
          const stat = fs.statSync(filePath);
          const content = fs.readFileSync(filePath, 'utf-8');
          const { meta, body } = parseWorkspaceArtifact<WorkspaceTaskDraftMeta>(content);
          const normalizedBody = body.trim();
          const relativePath = path.relative(rootPath, filePath);
          tasks.push({
            id: filePath,
            title: meta?.title || inferTitle(filePath, normalizedBody),
            detail: relativePath,
            updatedAt: stat.mtimeMs,
            status: meta?.draftStatus === 'doing' ? 'active' : 'idle',
            source: 'task-draft',
            scope: path.basename(rootPath) || rootPath,
            canRerun: false,
            canTerminate: false,
            taskType: 'draft',
            absolutePath: filePath,
            related: Array.isArray(meta?.related) ? meta.related : [],
            sourceNotePath: typeof meta?.sourceNotePath === 'string' ? meta.sourceNotePath : undefined,
            requirement: normalizedBody,
            draftStatus: meta?.draftStatus || 'todo',
          });
        } catch {
          // Ignore unreadable task drafts.
        }
      }
    }
    return tasks.sort((left, right) => right.updatedAt - left.updatedAt);
  }

  private collectRootPaths(): string[] {
    const result = new Set<string>();

    for (const folder of vscode.workspace.workspaceFolders || []) {
      result.add(folder.uri.fsPath);
    }

    for (const rootPath of this.extraRootPathsProvider?.() || []) {
      if (rootPath && rootPath.trim().length > 0) {
        result.add(rootPath);
      }
    }

    return Array.from(result.values());
  }

  async openTask(id: string): Promise<boolean> {
    if (!fs.existsSync(id)) { return false; }
    const document = await vscode.workspace.openTextDocument(id);
    await vscode.window.showTextDocument(document, { preview: false });
    return true;
  }
}

function collectMarkdownFiles(rootDir: string): string[] {
  const files: string[] = [];
  const pending = [rootDir];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) { continue; }
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(fullPath);
        continue;
      }
      if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        files.push(fullPath);
      }
    }
  }
  return files;
}

function inferTitle(filePath: string, content: string): string {
  const heading = content.split(/\r?\n/).map(line => line.trim()).find(line => line.startsWith('# '));
  if (heading) {
    return heading.slice(2).trim();
  }
  return path.basename(filePath, path.extname(filePath));
}
