import { ConversationRecord, ProviderId } from './types';

export interface HttpConversationProvider {
  readonly id: ProviderId;

  listConversations(): ConversationRecord[];
  getConversation(id: string): ConversationRecord | null;
  getConversationMessages(id: string): object[] | null;
  renameConversation(id: string, newTitle: string): boolean;
  deleteConversation(id: string): boolean;
  createConversationAndWait?(
    input: {
      name: string;
      projectPath?: string;
      model?: string;
    },
    timeoutMs?: number,
  ): Promise<ConversationRecord | null>;
  prepareConversationForOpen?(id: string): boolean;
}

export interface HttpConversationRegistry {
  getProvider(id: ProviderId): HttpConversationProvider | undefined;
  getConversation(providerId: ProviderId, id: string): ConversationRecord | null;
  getConversationById(id: string, providerId?: ProviderId): ConversationRecord | null;
  getConversationMessages(providerId: ProviderId, id: string): object[] | null;
  refresh(): void;
}
