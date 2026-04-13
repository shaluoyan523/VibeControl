import * as vscode from 'vscode';
import { ConversationRecord, ProviderId } from '../types';

export interface CreateConversationInput {
  name: string;
  projectPath?: string;
  model?: string;
}

export interface ConversationProvider {
  readonly id: ProviderId;
  readonly label: string;
  readonly onDidChange?: vscode.Event<void>;

  listConversations(): ConversationRecord[];
  getConversation(id: string): ConversationRecord | null;
  getConversationMessages(id: string): object[] | null;

  createConversation(input: CreateConversationInput): Promise<ConversationRecord | null>;
  createConversationAndWait?(input: CreateConversationInput, timeoutMs?: number): Promise<ConversationRecord | null>;
  openConversation(conversation: ConversationRecord, newTab?: boolean): Promise<void>;
  openConversationInTerminal?(conversation: ConversationRecord): Promise<void>;
  activateConversation?(conversation: ConversationRecord): Promise<void>;
  renameConversation(id: string, newTitle: string): boolean;
  deleteConversation(id: string): boolean;
  prepareConversationForOpen?(id: string): boolean;
}
