import * as vscode from 'vscode';
import { WorkspaceEntityIndexService } from './workspaceEntityIndexService';
import { WorkspaceEntity } from './workspaceEntities';

type WorkspaceQuickPickItem = vscode.QuickPickItem & {
  entity: WorkspaceEntity;
};

export async function showWorkspaceSearch(indexService: WorkspaceEntityIndexService): Promise<void> {
  const quickPick = vscode.window.createQuickPick<WorkspaceQuickPickItem>();
  quickPick.matchOnDescription = true;
  quickPick.matchOnDetail = true;
  quickPick.placeholder = 'Search sessions, terminals, tasks, and notes';
  quickPick.buttons = [
    { iconPath: new vscode.ThemeIcon('pulse'), tooltip: 'Open Session Center' },
  ];

  const updateItems = () => {
    quickPick.items = indexService.searchEntities(quickPick.value).slice(0, 75).map(toQuickPickItem);
  };

  updateItems();

  quickPick.onDidChangeValue(() => updateItems());
  quickPick.onDidTriggerButton(() => {
    void vscode.commands.executeCommand('vibe-control.showSessionCenter');
  });
  quickPick.onDidTriggerItemButton((event) => {
    void indexService.performAction(event.item.entity.kind, event.item.entity.id, String(event.button.tooltip || ''));
  });
  quickPick.onDidAccept(() => {
    const entity = quickPick.selectedItems[0]?.entity;
    if (entity) {
      void indexService.openEntity(entity);
    }
    quickPick.hide();
  });
  quickPick.onDidHide(() => quickPick.dispose());
  quickPick.show();
}

function toQuickPickItem(entity: WorkspaceEntity): WorkspaceQuickPickItem {
  const buttons: vscode.QuickInputButton[] = buttonsForEntity(entity);
  return {
    label: `${iconPrefix(entity.icon)} ${entity.title}`,
    description: entity.description,
    detail: entity.detail,
    buttons,
    entity,
  };
}

function buttonsForEntity(entity: WorkspaceEntity): vscode.QuickInputButton[] {
  switch (entity.kind) {
    case 'session': {
      const buttons: vscode.QuickInputButton[] = [
        { iconPath: new vscode.ThemeIcon('go-to-file'), tooltip: 'openNewTab' },
        { iconPath: new vscode.ThemeIcon('note'), tooltip: 'createNote' },
      ];
      if (entity.session.isActive) {
        buttons.push(
          { iconPath: new vscode.ThemeIcon('debug-pause'), tooltip: 'interrupt' },
          { iconPath: new vscode.ThemeIcon('debug-stop'), tooltip: 'stop' },
        );
      }
      return buttons;
    }
    case 'terminal':
      return [
        { iconPath: new vscode.ThemeIcon('terminal'), tooltip: 'focus' },
        { iconPath: new vscode.ThemeIcon('note'), tooltip: 'createNote' },
        { iconPath: new vscode.ThemeIcon('trash'), tooltip: 'close' },
      ];
    case 'task': {
      if (entity.task.taskType === 'draft') {
        return [
          { iconPath: new vscode.ThemeIcon('go-to-file'), tooltip: 'open' },
          { iconPath: new vscode.ThemeIcon('note'), tooltip: 'createNote' },
          { iconPath: new vscode.ThemeIcon('copy'), tooltip: 'copyPath' },
        ];
      }
      const buttons: vscode.QuickInputButton[] = [
        { iconPath: new vscode.ThemeIcon('list-unordered'), tooltip: 'showLog' },
        { iconPath: new vscode.ThemeIcon('note'), tooltip: 'createNote' },
        { iconPath: new vscode.ThemeIcon('refresh'), tooltip: 'rerun' },
      ];
      if (entity.task.canTerminate) {
        buttons.push({ iconPath: new vscode.ThemeIcon('debug-stop'), tooltip: 'terminate' });
      }
      return buttons;
    }
    case 'note':
      return [
        { iconPath: new vscode.ThemeIcon('sparkle'), tooltip: 'convertToTask' },
        { iconPath: new vscode.ThemeIcon('copy'), tooltip: 'copyPath' },
      ];
  }
}

function iconPrefix(icon: string): string {
  return `$(${icon})`;
}
