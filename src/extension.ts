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

  const extJsPath = path.join(claudeExt.extensionPath, 'extension.js');
  if (!fs.existsSync(extJsPath)) { return false; }

  const content = fs.readFileSync(extJsPath, 'utf-8');
  if (content.includes('__vibeControlCwd')) { return false; } // already patched

  const pattern = /(\w+)\.realpathSync\((\w+)\[0\]\|\|(\w+)\.homedir\(\)\)\.normalize\("NFC"\)/g;
  const patched = content.replace(pattern, (match) => `global.__vibeControlCwd||${match}`);

  if (patched === content) { return false; }

  try {
    fs.writeFileSync(extJsPath, patched, 'utf-8');
    return true;
  } catch {
    return false;
  }
}

async function openSession(sessionId?: string, cwd?: string): Promise<void> {
  if (cwd) {
    try {
      g.__vibeControlCwd = fs.realpathSync(cwd).normalize('NFC');
    } catch {
      g.__vibeControlCwd = cwd;
    }
  }
  try {
    await vscode.commands.executeCommand('claude-vscode.editor.open', sessionId);
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

  // New Session: prompt for name, then open
  context.subscriptions.push(
    vscode.commands.registerCommand('vibe-control.newSession', async () => {
      // 1. Ask for session name
      const name = await vscode.window.showInputBox({
        prompt: 'Session name',
        placeHolder: 'e.g. Feature: Auth Refactor',
      });
      if (!name) { return; }

      // 2. Ask for project path
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

      // 3. Open the new Claude session
      if (cwd) { g.__vibeControlCwd = cwd; }
      try {
        await vscode.commands.executeCommand('claude-vscode.editor.open');
      } finally {
        g.__vibeControlCwd = undefined;
      }

      // 4. Wait for .jsonl to appear, then write the custom title
      //    The session file is created almost immediately by Claude Code
      const targetDir = cwd || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (targetDir) {
        waitForNewSessionAndRename(sessionManager, targetDir, name);
      }
    }),
  );

  // Open/Resume Session
  context.subscriptions.push(
    vscode.commands.registerCommand('vibe-control.openSession', async (sessionId: string, cwd?: string) => {
      if (!sessionId) { return; }
      await openSession(sessionId, cwd);
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

      if (cwd) { g.__vibeControlCwd = cwd; }
      try {
        await vscode.commands.executeCommand('claude-vscode.editor.open');
      } finally {
        g.__vibeControlCwd = undefined;
      }

      waitForNewSessionAndRename(sessionManager, cwd, name);
    }),
  );

  // Switch Workspace — multi-root with anchor folder (no reload)
  // The anchor folder (extension install path) always stays at index 0.
  // We add/remove project folders at index 1+ to switch context without reloading.
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

      // Already present → no-op
      if (folders.some(f => f.uri.fsPath === targetPath)) {
        vscode.window.showInformationMessage(`"${path.basename(targetPath)}" is already in the workspace.`);
        return;
      }

      // Ensure anchor folder at index 0
      const anchorPath = context.extensionPath;
      const anchorUri = vscode.Uri.file(anchorPath);
      const hasAnchor = folders.length > 0 && folders[0].uri.fsPath === anchorPath;

      if (folders.length === 0) {
        // Empty workspace: add anchor + target
        vscode.workspace.updateWorkspaceFolders(0, 0,
          { uri: anchorUri, name: '🎛 Vibe Control (anchor)' },
          { uri: targetUri },
        );
      } else if (!hasAnchor) {
        // No anchor yet: insert anchor at 0, replace all others with target
        vscode.workspace.updateWorkspaceFolders(0, folders.length,
          { uri: anchorUri, name: '🎛 Vibe Control (anchor)' },
          { uri: targetUri },
        );
      } else {
        // Anchor exists at 0: replace everything after it with the new target
        const removeCount = folders.length - 1; // keep index 0
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
 * Claude Code creates the file within ~1s of opening a new panel.
 */
function waitForNewSessionAndRename(
  manager: SessionManager,
  _projectPath: string,
  title: string,
): void {
  const projectsDir = manager.projectsDir;

  // Get current session IDs before the new one appears
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
    if (attempts > 30) { clearInterval(interval); return; } // give up after 15s

    if (!fs.existsSync(projectsDir)) { return; }
    const dirs = fs.readdirSync(projectsDir, { withFileTypes: true }).filter(d => d.isDirectory());
    for (const dir of dirs) {
      const files = fs.readdirSync(path.join(projectsDir, dir.name)).filter(f => f.endsWith('.jsonl'));
      for (const f of files) {
        const sid = f.slice(0, -6);
        if (!existingIds.has(sid)) {
          // Found the new session
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
