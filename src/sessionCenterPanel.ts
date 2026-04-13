import * as vscode from 'vscode';
import {
  defaultWorkspaceControlState,
  SessionInteractionSnapshot,
  WorkspaceControlState,
  WorkspaceEntity,
  WorkspaceEntityStats,
} from './workspaceEntities';
import { WorkspaceEntityIndexService } from './workspaceEntityIndexService';

const STATE_KEY = 'workspaceControlCenterState';

type ControlPayload = {
  state: WorkspaceControlState;
  autoApprovePermissions: boolean;
  stats: WorkspaceEntityStats;
  visibleStats: WorkspaceEntityStats;
  attention: WorkspaceEntity[];
  activeSessions: WorkspaceEntity[];
  taskFocus: WorkspaceEntity[];
  sessionInteractions: SessionInteractionSnapshot[];
  openTerminals: WorkspaceEntity[];
  recentNotes: WorkspaceEntity[];
  results: WorkspaceEntity[];
};

export class SessionCenterPanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | null = null;
  private readonly disposables: vscode.Disposable[] = [];
  private state: WorkspaceControlState;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly workspaceEntityIndexService: WorkspaceEntityIndexService,
    private readonly workspaceState: vscode.Memento,
    private readonly getAutoApprovePermissions: () => boolean,
    private readonly setAutoApprovePermissions: (value: boolean) => Promise<void>,
  ) {
    this.state = reviveControlState(this.workspaceState.get<WorkspaceControlState | undefined>(STATE_KEY));
    this.disposables.push(
      this.workspaceEntityIndexService.onDidChange(() => {
        this.postState();
      }),
    );
  }

  show(): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Beside);
      this.postState();
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      'vibeControlSessionCenter',
      'Vibe Control: Session Center',
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      },
    );

    this.panel.onDidDispose(() => {
      this.panel = null;
    }, null, this.disposables);
    this.panel.webview.onDidReceiveMessage((message) => {
      void this.handleMessage(message);
    }, null, this.disposables);
    this.panel.webview.html = renderHtml(this.panel.webview.cspSource);
  }

  dispose(): void {
    const panel = this.panel;
    this.panel = null;
    panel?.dispose();
    while (this.disposables.length > 0) {
      this.disposables.pop()?.dispose();
    }
  }

  refresh(): void {
    this.postState();
  }

  private async handleMessage(message: unknown): Promise<void> {
    if (!message || typeof message !== 'object') { return; }
    const data = message as Record<string, unknown>;
    const type = typeof data.type === 'string' ? data.type : '';

    switch (type) {
      case 'ready':
        this.postState();
        return;
      case 'setFilters': {
        const nextState = reviveControlState(data.state);
        this.state = nextState;
        await this.workspaceState.update(STATE_KEY, nextState);
        this.postState();
        return;
      }
      case 'action': {
        const kind = typeof data.kind === 'string' ? data.kind : '';
        const id = typeof data.id === 'string' ? data.id : '';
        const action = typeof data.action === 'string' ? data.action : '';
        if (!kind || !id || !action) { return; }
        await this.workspaceEntityIndexService.performAction(kind as WorkspaceEntity['kind'], id, action);
        return;
      }
      case 'interactionAction': {
        const id = typeof data.id === 'string' ? data.id : '';
        const action = typeof data.action === 'string' ? data.action : '';
        if (!id || !action) { return; }
        await this.workspaceEntityIndexService.performSessionInteractionAction(id, action);
        return;
      }
      case 'newNote':
        await vscode.commands.executeCommand('vibe-control.newNote');
        return;
      case 'setAutoApprovePermissions': {
        await this.setAutoApprovePermissions(Boolean(data.value));
        this.postState();
        return;
      }
    }
  }

  private postState(): void {
    if (!this.panel) { return; }

    const results = this.workspaceEntityIndexService.getEntitiesForState(this.state).slice(0, 40);
    const stats = this.workspaceEntityIndexService.getStats();
    const payload: ControlPayload = {
      state: this.state,
      autoApprovePermissions: this.getAutoApprovePermissions(),
      stats,
      visibleStats: this.workspaceEntityIndexService.getStats(results),
      attention: this.workspaceEntityIndexService.getAttentionEntities(8),
      activeSessions: this.workspaceEntityIndexService.listEntities('session')
        .filter((entity): entity is Extract<WorkspaceEntity, { kind: 'session' }> => entity.kind === 'session')
        .filter((entity) => entity.session.isActive)
        .slice(0, 8),
      taskFocus: this.workspaceEntityIndexService.listEntities('task')
        .filter((entity) => entity.status === 'active' || entity.status === 'error')
        .slice(0, 8),
      sessionInteractions: this.workspaceEntityIndexService.listSessionInteractions(8),
      openTerminals: this.workspaceEntityIndexService.listEntities('terminal')
        .filter((entity) => entity.status === 'active')
        .slice(0, 8),
      recentNotes: this.workspaceEntityIndexService.listEntities('note').slice(0, 8),
      results,
    };

    void this.panel.webview.postMessage({ type: 'update', payload });
  }
}

function reviveControlState(input: unknown): WorkspaceControlState {
  const fallback = defaultWorkspaceControlState();
  if (!input || typeof input !== 'object') {
    return fallback;
  }
  const record = input as Record<string, unknown>;
  const query = typeof record.query === 'string' ? record.query : fallback.query;
  const kindFilter = record.kindFilter === 'session'
    || record.kindFilter === 'terminal'
    || record.kindFilter === 'task'
    || record.kindFilter === 'note'
    || record.kindFilter === 'all'
    ? record.kindFilter
    : fallback.kindFilter;
  return { query, kindFilter };
}

function renderHtml(cspSource: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'unsafe-inline';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Session Center</title>
  <style>
    :root {
      color-scheme: light dark;
      --bg: var(--vscode-editor-background);
      --panel: color-mix(in srgb, var(--bg) 90%, white 10%);
      --card: color-mix(in srgb, var(--bg) 82%, white 18%);
      --fg: var(--vscode-editor-foreground);
      --muted: var(--vscode-descriptionForeground);
      --border: var(--vscode-panel-border);
      --accent: var(--vscode-button-background);
      --accent-fg: var(--vscode-button-foreground);
      --warning: var(--vscode-editorWarning-foreground);
      --error: var(--vscode-errorForeground);
    }
    body {
      margin: 0;
      padding: 16px;
      background: var(--bg);
      color: var(--fg);
      font-family: var(--vscode-font-family);
    }
    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
      margin-bottom: 14px;
    }
    .title-block h1 {
      margin: 0;
      font-size: 20px;
    }
    .title-block p {
      margin: 4px 0 0;
      color: var(--muted);
      font-size: 12px;
    }
    .header-actions {
      display: flex;
      gap: 8px;
      align-items: center;
    }
    .toggle {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      color: var(--muted);
      font-size: 12px;
    }
    .toggle input {
      width: auto;
      margin: 0;
    }
    .toolbar {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 160px;
      gap: 10px;
      margin-bottom: 14px;
    }
    input, select {
      width: 100%;
      box-sizing: border-box;
      border: 1px solid var(--border);
      background: var(--panel);
      color: var(--fg);
      border-radius: 8px;
      padding: 10px 12px;
    }
    .stats {
      display: grid;
      grid-template-columns: repeat(5, minmax(0, 1fr));
      gap: 10px;
      margin-bottom: 16px;
    }
    .stat {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 12px;
    }
    .stat-label {
      color: var(--muted);
      font-size: 12px;
      margin-bottom: 6px;
    }
    .stat-value {
      font-size: 22px;
      font-weight: 700;
    }
    .section-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 14px;
    }
    .section {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 14px;
    }
    .section h2 {
      margin: 0 0 10px;
      font-size: 15px;
    }
    .entity-list {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .entity {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 10px;
    }
    .entity.attention {
      border-color: var(--warning);
    }
    .entity.error {
      border-color: var(--error);
    }
    .entity-header {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      align-items: baseline;
      margin-bottom: 6px;
    }
    .entity-title {
      font-weight: 600;
    }
    .badge {
      border: 1px solid var(--border);
      border-radius: 999px;
      padding: 2px 8px;
      font-size: 11px;
      color: var(--muted);
    }
    .badge.attention {
      color: var(--warning);
    }
    .badge.error {
      color: var(--error);
    }
    .description, .detail, .empty {
      color: var(--muted);
      font-size: 12px;
    }
    .description {
      margin-bottom: 4px;
    }
    .detail {
      margin-bottom: 8px;
      word-break: break-word;
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }
    button {
      border: 0;
      border-radius: 7px;
      padding: 6px 10px;
      cursor: pointer;
      background: var(--accent);
      color: var(--accent-fg);
    }
    button.secondary {
      background: transparent;
      border: 1px solid var(--border);
      color: var(--fg);
    }
    .results-only {
      margin-top: 6px;
    }
    @media (max-width: 900px) {
      .stats, .section-grid, .toolbar {
        grid-template-columns: 1fr;
      }
    }
  </style>
</head>
<body>
  <div class="header">
    <div class="title-block">
      <h1>Session Center</h1>
      <p>Workspace search and control for sessions, terminals, tasks, and notes.</p>
    </div>
    <div class="header-actions">
      <label class="toggle">
        <input id="autoApprovePermissions" type="checkbox" />
        <span>Auto-Approve Permissions</span>
      </label>
      <button id="newNoteButton" class="secondary">New Note</button>
    </div>
  </div>
  <div class="toolbar">
    <input id="query" type="search" placeholder="Search sessions, terminals, tasks, and notes" />
    <select id="kindFilter">
      <option value="all">All Entities</option>
      <option value="session">Sessions</option>
      <option value="terminal">Terminals</option>
      <option value="task">Tasks</option>
      <option value="note">Notes</option>
    </select>
  </div>
  <div id="stats" class="stats"></div>
  <div id="sections"></div>
  <script>
    const vscode = acquireVsCodeApi();
    const queryInput = document.getElementById('query');
    const kindFilter = document.getElementById('kindFilter');
    const autoApprovePermissions = document.getElementById('autoApprovePermissions');
    const newNoteButton = document.getElementById('newNoteButton');
    const statsEl = document.getElementById('stats');
    const sectionsEl = document.getElementById('sections');
    let latestPayload = null;

    function escapeHtml(value) {
      return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    function sendFilters() {
      vscode.postMessage({
        type: 'setFilters',
        state: {
          query: queryInput.value,
          kindFilter: kindFilter.value,
        },
      });
    }

    queryInput.addEventListener('input', sendFilters);
    kindFilter.addEventListener('change', sendFilters);
    newNoteButton.addEventListener('click', () => {
      vscode.postMessage({ type: 'newNote' });
    });
    autoApprovePermissions.addEventListener('change', () => {
      vscode.postMessage({ type: 'setAutoApprovePermissions', value: autoApprovePermissions.checked });
    });
    sectionsEl.addEventListener('click', (event) => {
      const target = event.target;
      if (!(target instanceof HTMLButtonElement)) { return; }
      const interactionAction = target.dataset.interactionAction;
      const interactionId = target.dataset.interactionId;
      if (interactionAction && interactionId) {
        vscode.postMessage({ type: 'interactionAction', action: interactionAction, id: interactionId });
        return;
      }
      const action = target.dataset.action;
      const id = target.dataset.id;
      const kind = target.dataset.kind;
      if (!action || !id || !kind) { return; }
      vscode.postMessage({ type: 'action', action, id, kind });
    });

    window.addEventListener('message', (event) => {
      const message = event.data;
      if (!message || message.type !== 'update') { return; }
      latestPayload = message.payload;
      render(message.payload);
    });

    function render(payload) {
      queryInput.value = payload.state.query;
      kindFilter.value = payload.state.kindFilter;
      autoApprovePermissions.checked = !!payload.autoApprovePermissions;
      statsEl.innerHTML = [
        renderStat('Total', payload.stats.total),
        renderStat('Visible', payload.visibleStats.total),
        renderStat('Active', payload.stats.active),
        renderStat('Attention', payload.stats.attention),
        renderStat('Errors', payload.stats.errors),
      ].join('');

      if (payload.state.query.trim()) {
        sectionsEl.innerHTML = '<div class="results-only">' + renderSection('Results', payload.results) + '</div>';
        return;
      }

        sectionsEl.innerHTML = '<div class="section-grid">'
        + renderSection('Attention', payload.attention)
        + renderSection('Active Sessions', payload.activeSessions)
        + renderSection('Task Focus', payload.taskFocus)
        + renderInteractionSection('Session Handoffs', payload.sessionInteractions)
        + renderSection('Open Terminals', payload.openTerminals)
        + renderSection('Recent Notes', payload.recentNotes)
        + '</div>';
    }

    function renderStat(label, value) {
      return '<div class="stat"><div class="stat-label">' + escapeHtml(label) + '</div><div class="stat-value">' + escapeHtml(value) + '</div></div>';
    }

    function renderSection(title, entities) {
      const body = entities.length > 0
        ? '<div class="entity-list">' + entities.map(renderEntity).join('') + '</div>'
        : '<div class="empty">No items</div>';
      return '<section class="section"><h2>' + escapeHtml(title) + '</h2>' + body + '</section>';
    }

    function renderInteractionSection(title, interactions) {
      const body = interactions.length > 0
        ? '<div class="entity-list">' + interactions.map(renderInteraction).join('') + '</div>'
        : '<div class="empty">No items</div>';
      return '<section class="section"><h2>' + escapeHtml(title) + '</h2>' + body + '</section>';
    }

    function renderEntity(entity) {
      const badgeClass = entity.attentionReason === 'error'
        ? 'badge error'
        : entity.attentionReason !== 'none'
          ? 'badge attention'
          : 'badge';
      const entityClass = entity.attentionReason === 'error'
        ? 'entity error'
        : entity.attentionReason !== 'none'
          ? 'entity attention'
          : 'entity';
      return '<article class="' + entityClass + '">' +
        '<div class="entity-header">' +
          '<div class="entity-title">$(' + escapeHtml(entity.icon) + ') ' + escapeHtml(entity.title) + '</div>' +
          '<div class="' + badgeClass + '">' + escapeHtml(entity.attentionReason !== 'none' ? entity.attentionReason : entity.status) + '</div>' +
        '</div>' +
        '<div class="description">' + escapeHtml(entity.description) + '</div>' +
        '<div class="detail">' + escapeHtml(entity.detail) + '</div>' +
        '<div class="actions">' + renderActions(entity) + '</div>' +
      '</article>';
    }

    function renderActions(entity) {
      return actionsForEntity(entity).map((action) => {
        const className = action.variant === 'secondary' ? 'secondary' : '';
        return '<button class="' + className + '" data-kind="' + escapeHtml(entity.kind) + '" data-id="' + escapeHtml(entity.id) + '" data-action="' + escapeHtml(action.id) + '">' + escapeHtml(action.label) + '</button>';
      }).join('');
    }

    function renderInteraction(interaction) {
      const artifactLabel = interaction.artifactKind === 'task' ? 'Task Draft' : 'Note';
      return '<article class="entity">' +
        '<div class="entity-header">' +
          '<div class="entity-title">$(arrow-swap) ' + escapeHtml(interaction.title) + '</div>' +
          '<div class="badge">' + escapeHtml(artifactLabel) + '</div>' +
        '</div>' +
        '<div class="description">' + escapeHtml(interaction.summary) + '</div>' +
        '<div class="detail">' + escapeHtml(interaction.detail) + '</div>' +
        '<div class="actions">' +
          renderInteractionButton(interaction, 'openArtifact', 'Open Artifact', 'primary') +
          renderInteractionButton(interaction, 'openSource', 'Open Source', 'secondary') +
          renderInteractionButton(interaction, 'openTarget', 'Open Target', 'secondary') +
          renderInteractionButton(interaction, 'copyPath', 'Copy Path', 'secondary') +
        '</div>' +
      '</article>';
    }

    function renderInteractionButton(interaction, action, label, variant) {
      const className = variant === 'secondary' ? 'secondary' : '';
      return '<button class="' + className + '" data-interaction-id="' + escapeHtml(interaction.id) + '" data-interaction-action="' + escapeHtml(action) + '">' + escapeHtml(label) + '</button>';
    }

    function actionsForEntity(entity) {
      switch (entity.kind) {
        case 'session': {
          const actions = [
            { id: 'open', label: 'Open', variant: 'primary' },
            { id: 'createNote', label: 'Create Note', variant: 'secondary' },
            { id: 'openNewTab', label: 'New Tab', variant: 'secondary' },
            { id: 'copyId', label: 'Copy ID', variant: 'secondary' },
          ];
          if (entity.session.isActive) {
            actions.push(
              { id: 'interrupt', label: 'Interrupt', variant: 'secondary' },
              { id: 'stop', label: 'Stop', variant: 'secondary' },
            );
          }
          return actions;
        }
        case 'terminal':
          return [
            { id: 'focus', label: 'Focus', variant: 'primary' },
            { id: 'createNote', label: 'Create Note', variant: 'secondary' },
            { id: 'close', label: 'Close', variant: 'secondary' },
          ];
        case 'task': {
          if (entity.task.taskType === 'draft') {
            return [
              { id: 'open', label: 'Open', variant: 'primary' },
              { id: 'createNote', label: 'Create Note', variant: 'secondary' },
              { id: 'copyPath', label: 'Copy Path', variant: 'secondary' },
            ];
          }
          const actions = [
            { id: 'showLog', label: 'Show Log', variant: 'primary' },
            { id: 'createNote', label: 'Create Note', variant: 'secondary' },
            { id: 'rerun', label: 'Rerun', variant: 'secondary' },
          ];
          if (entity.task.canTerminate) {
            actions.push({ id: 'terminate', label: 'Terminate', variant: 'secondary' });
          }
          return actions;
        }
        case 'note':
          return [
            { id: 'open', label: 'Open', variant: 'primary' },
            { id: 'convertToTask', label: 'Convert To Task', variant: 'secondary' },
            { id: 'copyPath', label: 'Copy Path', variant: 'secondary' },
          ];
        default:
          return [];
      }
    }

    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
}
