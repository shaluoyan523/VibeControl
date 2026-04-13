import * as vscode from 'vscode';
import { ConversationRecord, UnifiedProjectGroup } from './types';
import { ConversationProvider } from './providers/types';

export class ConversationManager {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  constructor(private readonly providers: ConversationProvider[]) {
    for (const provider of providers) {
      provider.onDidChange?.(() => this._onDidChange.fire());
    }
  }

  refresh(): void {
    this._onDidChange.fire();
  }

  getProviders(): ConversationProvider[] {
    return this.providers;
  }

  getProvider(id: ConversationRecord['provider']): ConversationProvider | undefined {
    return this.providers.find(provider => provider.id === id);
  }

  getConversation(providerId: ConversationRecord['provider'], id: string): ConversationRecord | null {
    return this.getProvider(providerId)?.getConversation(id) || null;
  }

  getConversationById(id: string, providerId?: ConversationRecord['provider']): ConversationRecord | null {
    if (providerId) {
      return this.getConversation(providerId, id);
    }

    for (const provider of this.providers) {
      const conversation = provider.getConversation(id);
      if (conversation) {
        return conversation;
      }
    }

    return null;
  }

  getConversationMessages(providerId: ConversationRecord['provider'], id: string): object[] | null {
    return this.getProvider(providerId)?.getConversationMessages(id) || null;
  }

  getProjectGroups(): UnifiedProjectGroup[] {
    const byKey = new Map<string, UnifiedProjectGroup>();

    for (const conversation of this.listConversations()) {
      const key = conversation.cwd || `${conversation.provider}:no-cwd`;
      const label = conversation.cwd || 'Unknown Project';
      const existing = byKey.get(key);

      if (existing) {
        existing.conversations.push(conversation);
      } else {
        byKey.set(key, {
          key,
          label,
          cwd: conversation.cwd,
          conversations: [conversation],
        });
      }
    }

    const groups = Array.from(byKey.values());
    for (const group of groups) {
      group.conversations.sort((a, b) => b.lastModified - a.lastModified);
    }

    groups.sort((a, b) => {
      const aTime = a.conversations[0]?.lastModified || 0;
      const bTime = b.conversations[0]?.lastModified || 0;
      return bTime - aTime;
    });

    return groups;
  }

  listConversations(): ConversationRecord[] {
    return this.providers
      .flatMap(provider => provider.listConversations())
      .sort((a, b) => b.lastModified - a.lastModified);
  }
}
