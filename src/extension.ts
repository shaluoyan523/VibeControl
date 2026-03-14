import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { SessionManager } from './sessionManager';
import { SessionTreeProvider } from './sessionTreeProvider';
import { ProcessManager } from './processManager';
import { HttpServer } from './httpServer';

const g = globalThis as any;

function patchOriginalExtension(): boolean {
  const claudeExt = vscode.extensions.getExtension('Anthropic.claude-code');
  if (!claudeExt) { return false; }

  let changed = false;
  const extJsPath = path.join(claudeExt.extensionPath, 'extension.js');
  if (!fs.existsSync(extJsPath)) { return false; }

  let content = fs.readFileSync(extJsPath, 'utf-8');

  // Patch 1: CWD override
  if (!content.includes('__vibeControlCwd')) {
    const pattern = /(\w+)\.realpathSync\((\w+)\[0\]\|\|(\w+)\.homedir\(\)\)\.normalize\("NFC"\)/g;
    const patched = content.replace(pattern, (match) => `global.__vibeControlCwd||${match}`);
    if (patched !== content) { content = patched; changed = true; }
  }

  // Patch 2: CSS injection — hide "New session" + "Past Conversations" buttons
  const cssMarker = '__vibeControlCSS';
  if (!content.includes(cssMarker)) {
    const templateStart = content.indexOf('return`<!DOCTYPE html>');
    if (templateStart >= 0) {
      const styleEnd = content.indexOf('</style>', templateStart);
      if (styleEnd >= 0) {
        const injectionPoint = styleEnd + '</style>'.length;
        const hideCSS = `\n        <style>/* ${cssMarker} */\n`
          + '          [class*="sessionsButton_"] { display: none !important; }\n'
          + '          [aria-label="New session"] { display: none !important; }\n'
          + '        </style>';
        content = content.substring(0, injectionPoint) + hideCSS + content.substring(injectionPoint);
        changed = true;
      }
    }
  }

  // Patch 3: Disable auto-rename of tab title (summary → title)
  const renameMarker = '__vibeControlNoRename';
  if (!content.includes(renameMarker)) {
    const renameTarget = '.panelTab.title=z.request.title';
    const idx = content.indexOf(renameTarget);
    if (idx >= 0) {
      // Replace with a no-op guarded by marker comment
      content = content.substring(0, idx) + `.panelTab.title/*${renameMarker}*/=this.panelTab.title` + content.substring(idx + renameTarget.length);
      changed = true;
    }
  }

  if (changed) {
    try { fs.writeFileSync(extJsPath, content, 'utf-8'); } catch { return false; }
  }
  return changed;
}

/** Close all Claude Code webview tabs and return their ViewColumn. */
async function closeClaudePanels(): Promise<vscode.ViewColumn | undefined> {
  let column: vscode.ViewColumn | undefined;
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      if (tab.input instanceof vscode.TabInputWebview
        && (tab.input as any).viewType?.includes('claudeVSCodePanel')) {
        column = group.viewColumn;
        await vscode.window.tabGroups.close(tab);
      }
    }
  }
  return column;
}

async function openSession(sessionId?: string, cwd?: string, newTab = false): Promise<void> {
  if (cwd) {
    try {
      g.__vibeControlCwd = fs.realpathSync(cwd).normalize('NFC');
    } catch {
      g.__vibeControlCwd = cwd;
    }
  }
  try {
    if (!newTab) {
      // Single-tab mode: close existing panels first, reopen in same column
      const col = await closeClaudePanels();
      await vscode.commands.executeCommand('claude-vscode.editor.open', sessionId, undefined, col);
    } else {
      await vscode.commands.executeCommand('claude-vscode.editor.open', sessionId);
    }
  } finally {
    g.__vibeControlCwd = undefined;
  }
}

export async function activate(context: vscode.ExtensionContext) {
  const needsReload = patchOriginalExtension();
  if (needsReload) {
    const action = await vscode.window.showInformationMessage(
      'Vibe Control: Patched Claude Code for per-session project path binding. Please reload.',
      'Reload Now',
    );
    if (action === 'Reload Now') {
      await vscode.commands.executeCommand('workbench.action.reloadWindow');
      return;
    }
  }

  const sessionManager = new SessionManager();
  const treeProvider = new SessionTreeProvider(sessionManager);

  const treeView = vscode.window.createTreeView('vibeSessionsList', {
    treeDataProvider: treeProvider,
    showCollapseAll: true,
  });
  context.subscriptions.push(treeView);

  // New Session: prompt for name, then open (always new tab)
  context.subscriptions.push(
    vscode.commands.registerCommand('vibe-control.newSession', async () => {
      const name = await vscode.window.showInputBox({
        prompt: 'Session name',
        placeHolder: 'e.g. Feature: Auth Refactor',
      });
      if (!name) { return; }

      const choices: vscode.QuickPickItem[] = [
        { label: '$(folder) Current Workspace', description: 'Use current workspace path' },
        { label: '$(folder-opened) Choose Folder...', description: 'Select a different project folder' },
      ];
      const pick = await vscode.window.showQuickPick(choices, {
        placeHolder: 'Where should this session work?',
      });
      if (!pick) { return; }

      let cwd: string | undefined;
      if (pick.label.includes('Choose Folder')) {
        const uri = await vscode.window.showOpenDialog({
          canSelectFolders: true,
          canSelectFiles: false,
          canSelectMany: false,
          openLabel: 'Select Project Folder',
          defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri,
        });
        if (!uri || uri.length === 0) { return; }
        cwd = uri[0].fsPath;
      }

      // Open new session (always new tab for creation)
      await openSession(undefined, cwd, true);

      // Wait for .jsonl to appear, then write the custom title
      const targetDir = cwd || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (targetDir) {
        waitForNewSessionAndRename(sessionManager, targetDir, name);
      }
    }),
  );

  // Open/Resume Session (single-tab by default)
  context.subscriptions.push(
    vscode.commands.registerCommand('vibe-control.openSession', async (sessionId: string, cwd?: string) => {
      if (!sessionId) { return; }
      await openSession(sessionId, cwd);
    }),
  );

  // Open Session in New Tab (right-click)
  context.subscriptions.push(
    vscode.commands.registerCommand('vibe-control.openSessionNewTab', async (item: any) => {
      const session = item?.session;
      if (!session?.sessionId) { return; }
      await openSession(session.sessionId, session.cwd, true);
    }),
  );

  // Delete Session
  context.subscriptions.push(
    vscode.commands.registerCommand('vibe-control.deleteSession', async (item: any) => {
      const session = item?.session;
      if (!session?.sessionId) { return; }
      const label = truncate(session.customTitle || session.summary || session.sessionId, 40);
      const confirm = await vscode.window.showWarningMessage(
        `Delete session "${label}"? This cannot be undone.`,
        { modal: true },
        'Delete',
      );
      if (confirm !== 'Delete') { return; }

      if (sessionManager.deleteSession(session.sessionId)) {
        sessionManager.refresh();
        vscode.window.showInformationMessage('Session deleted.');
      } else {
        vscode.window.showWarningMessage('Session file not found.');
      }
    }),
  );

  // Rename Session — via input box
  context.subscriptions.push(
    vscode.commands.registerCommand('vibe-control.renameSession', async (item: any) => {
      const session = item?.session;
      if (!session?.sessionId) { return; }

      const newName = await vscode.window.showInputBox({
        prompt: 'New session name',
        value: session.customTitle || session.summary || '',
        placeHolder: 'Enter new name',
      });
      if (!newName) { return; }

      if (sessionManager.renameSession(session.sessionId, newName)) {
        sessionManager.refresh();
      } else {
        vscode.window.showWarningMessage('Failed to rename session.');
      }
    }),
  );

  // New Session in specific project (right-click on project node)
  context.subscriptions.push(
    vscode.commands.registerCommand('vibe-control.newSessionInProject', async (item: any) => {
      const cwd = item?.group?.sessions?.[0]?.cwd;
      if (!cwd) {
        vscode.window.showWarningMessage('Cannot determine project path.');
        return;
      }

      const name = await vscode.window.showInputBox({
        prompt: 'Session name',
        placeHolder: 'e.g. Feature: Auth Refactor',
      });
      if (!name) { return; }

      await openSession(undefined, cwd, true);
      waitForNewSessionAndRename(sessionManager, cwd, name);
    }),
  );

  // Switch Workspace — multi-root with anchor folder (no reload)
  context.subscriptions.push(
    vscode.commands.registerCommand('vibe-control.switchWorkspace', async (item: any) => {
      let targetPath: string | undefined;
      if (item?.session?.cwd) {
        targetPath = item.session.cwd;
      } else if (item?.group?.sessions?.[0]?.cwd) {
        targetPath = item.group.sessions[0].cwd;
      }

      if (!targetPath || !fs.existsSync(targetPath)) {
        vscode.window.showWarningMessage('Cannot determine project path.');
        return;
      }

      const targetUri = vscode.Uri.file(targetPath);
      const folders = vscode.workspace.workspaceFolders || [];

      if (folders.some(f => f.uri.fsPath === targetPath)) {
        vscode.window.showInformationMessage(`"${path.basename(targetPath)}" is already in the workspace.`);
        return;
      }

      const anchorPath = context.extensionPath;
      const anchorUri = vscode.Uri.file(anchorPath);
      const hasAnchor = folders.length > 0 && folders[0].uri.fsPath === anchorPath;

      if (folders.length === 0) {
        vscode.workspace.updateWorkspaceFolders(0, 0,
          { uri: anchorUri, name: '🎛 Vibe Control (anchor)' },
          { uri: targetUri },
        );
      } else if (!hasAnchor) {
        vscode.workspace.updateWorkspaceFolders(0, folders.length,
          { uri: anchorUri, name: '🎛 Vibe Control (anchor)' },
          { uri: targetUri },
        );
      } else {
        const removeCount = folders.length - 1;
        if (removeCount > 0) {
          vscode.workspace.updateWorkspaceFolders(1, removeCount, { uri: targetUri });
        } else {
          vscode.workspace.updateWorkspaceFolders(1, 0, { uri: targetUri });
        }
      }
    }),
  );

  // Refresh Sessions
  context.subscriptions.push(
    vscode.commands.registerCommand('vibe-control.refreshSessions', () => {
      sessionManager.refresh();
    }),
  );

  // HTTP API Server
  const config = vscode.workspace.getConfiguration('vibe-control');
  const enableHttp = config.get<boolean>('enableHttpServer', true);
  if (enableHttp) {
    const port = config.get<number>('httpPort', 23816);
    const processManager = new ProcessManager(context.extensionPath);
    const httpServer = new HttpServer(sessionManager, processManager, port);

    httpServer.start().then((actualPort) => {
      console.log(`Vibe Control HTTP API running on http://127.0.0.1:${actualPort}`);
    }).catch((err) => {
      console.error('Vibe Control: Failed to start HTTP server:', err.message);
    });

    context.subscriptions.push({ dispose: () => { httpServer.dispose(); processManager.dispose(); } });
  }
}

/**
 * Poll for a newly created .jsonl file in the project dir and write customTitle.
 */
function waitForNewSessionAndRename(
  manager: SessionManager,
  _projectPath: string,
  title: string,
): void {
  const projectsDir = manager.projectsDir;

  const existingIds = new Set<string>();
  if (fs.existsSync(projectsDir)) {
    const dirs = fs.readdirSync(projectsDir, { withFileTypes: true }).filter(d => d.isDirectory());
    for (const dir of dirs) {
      const files = fs.readdirSync(path.join(projectsDir, dir.name)).filter(f => f.endsWith('.jsonl'));
      for (const f of files) { existingIds.add(f.slice(0, -6)); }
    }
  }

  let attempts = 0;
  const interval = setInterval(() => {
    attempts++;
    if (attempts > 30) { clearInterval(interval); return; }

    if (!fs.existsSync(projectsDir)) { return; }
    const dirs = fs.readdirSync(projectsDir, { withFileTypes: true }).filter(d => d.isDirectory());
    for (const dir of dirs) {
      const files = fs.readdirSync(path.join(projectsDir, dir.name)).filter(f => f.endsWith('.jsonl'));
      for (const f of files) {
        const sid = f.slice(0, -6);
        if (!existingIds.has(sid)) {
          manager.renameSession(sid, title);
          manager.refresh();
          clearInterval(interval);
          return;
        }
      }
    }
  }, 500);
}

function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) { return s; }
  return s.slice(0, maxLen - 3) + '...';
}

export function deactivate() {}
