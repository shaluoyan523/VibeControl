import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { NoteSnapshot } from './workspaceEntities';
import { parseWorkspaceArtifact, relationSummary, WorkspaceNoteMeta } from './workspaceArtifacts';

export class NoteRegistry implements vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly watcher: vscode.FileSystemWatcher;

  constructor(
    private readonly extraRootPathsProvider: (() => string[]) | null = null,
  ) {
    this.watcher = vscode.workspace.createFileSystemWatcher('**/.vibe-control/notes/**/*.md');
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

  refresh(): void {
    this._onDidChange.fire();
  }

  listNotes(): NoteSnapshot[] {
    const notes: NoteSnapshot[] = [];
    const seenFilePaths = new Set<string>();

    for (const rootPath of this.collectRootPaths()) {
      const notesDir = path.join(rootPath, '.vibe-control', 'notes');
      if (!fs.existsSync(notesDir) || !fs.statSync(notesDir).isDirectory()) {
        continue;
      }

      for (const filePath of collectMarkdownFiles(notesDir)) {
        if (seenFilePaths.has(filePath)) {
          continue;
        }
        seenFilePaths.add(filePath);

        try {
          const stat = fs.statSync(filePath);
          const content = fs.readFileSync(filePath, 'utf-8');
          const relativePath = path.relative(rootPath, filePath);
          const { meta, body } = parseWorkspaceArtifact<WorkspaceNoteMeta>(content);
          const related = Array.isArray(meta?.related) ? meta.related : [];
          const relatedDetail = relationSummary(related);

          notes.push({
            id: filePath,
            title: meta?.title || inferTitle(filePath, body),
            detail: relatedDetail ? `${relativePath} · ${relatedDetail}` : relativePath,
            excerpt: buildExcerpt(body),
            updatedAt: stat.mtimeMs,
            absolutePath: filePath,
            relativePath,
            related,
          });
        } catch {
          // Ignore unreadable notes.
        }
      }
    }

    return notes.sort((left, right) => right.updatedAt - left.updatedAt);
  }

  async openNote(id: string): Promise<boolean> {
    if (!fs.existsSync(id)) { return false; }
    const document = await vscode.workspace.openTextDocument(id);
    await vscode.window.showTextDocument(document, { preview: false });
    return true;
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
  const heading = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.startsWith('# '));
  if (heading) {
    return heading.slice(2).trim();
  }
  return path.basename(filePath, path.extname(filePath));
}

function buildExcerpt(content: string): string {
  const normalized = content.replace(/\s+/g, ' ').trim();
  if (!normalized) { return 'Empty note'; }
  return normalized.length > 160 ? `${normalized.slice(0, 157)}...` : normalized;
}
