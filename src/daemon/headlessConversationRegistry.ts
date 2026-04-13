import { HttpConversationProvider, HttpConversationRegistry } from '../httpRuntime';
import { ConversationRecord, ProviderId } from '../types';

export class HeadlessConversationRegistry implements HttpConversationRegistry {
  constructor(private readonly providers: HttpConversationProvider[]) {}

  getProvider(id: ProviderId): HttpConversationProvider | undefined {
    return this.providers.find(provider => provider.id === id);
  }

  getConversation(providerId: ProviderId, id: string): ConversationRecord | null {
    return this.getProvider(providerId)?.getConversation(id) || null;
  }

  getConversationById(id: string, providerId?: ProviderId): ConversationRecord | null {
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

  getConversationMessages(providerId: ProviderId, id: string): object[] | null {
    return this.getProvider(providerId)?.getConversationMessages(id) || null;
  }

  refresh(): void {
    // Headless registry reads directly from disk on each call.
  }
}
