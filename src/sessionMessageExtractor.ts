import { ProviderId } from './types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeMessageText(value: string): string | null {
  const normalized = value.replace(/\r\n?/g, '\n').trim();
  return normalized.length > 0 ? normalized : null;
}

function collectTextContent(content: unknown, blockType: string, textKey: string): string | null {
  if (!Array.isArray(content)) {
    return null;
  }

  const blocks = content
    .flatMap((block) => {
      if (!isRecord(block) || block.type !== blockType || typeof block[textKey] !== 'string') {
        return [];
      }

      const normalized = normalizeMessageText(block[textKey]);
      return normalized ? [normalized] : [];
    })
    .filter((text) => text.length > 0);

  if (blocks.length === 0) {
    return null;
  }

  return blocks.join('\n\n');
}

function extractClaudeAssistantMessage(parsed: unknown): string | null {
  if (!isRecord(parsed) || parsed.type !== 'assistant' || !isRecord(parsed.message)) {
    return null;
  }

  const textBlocks = collectTextContent(parsed.message.content, 'text', 'text');
  if (textBlocks) {
    return textBlocks;
  }

  if (typeof parsed.message.content === 'string') {
    return normalizeMessageText(parsed.message.content);
  }

  return null;
}

function extractCodexAssistantMessage(parsed: unknown): string | null {
  if (!isRecord(parsed) || typeof parsed.type !== 'string') {
    return null;
  }

  if (parsed.type === 'response_item') {
    const payload = parsed.payload;
    if (!isRecord(payload) || payload.type !== 'message' || payload.role !== 'assistant') {
      return null;
    }

    const outputText = collectTextContent(payload.content, 'output_text', 'text');
    if (outputText) {
      return outputText;
    }

    const textBlocks = collectTextContent(payload.content, 'text', 'text');
    if (textBlocks) {
      return textBlocks;
    }

    return null;
  }

  if (parsed.type !== 'event_msg' || !isRecord(parsed.payload)) {
    return null;
  }

  const payload = parsed.payload;
  if (payload.type === 'task_complete' && typeof payload.last_agent_message === 'string') {
    return normalizeMessageText(payload.last_agent_message);
  }

  if (payload.type === 'agent_message' && typeof payload.message === 'string') {
    return normalizeMessageText(payload.message);
  }

  return null;
}

export function extractLastAssistantMessage(
  provider: ProviderId,
  messages: object[] | null | undefined,
): string | null {
  if (!Array.isArray(messages) || messages.length === 0) {
    return null;
  }

  let lastMessage: string | null = null;
  for (const message of messages) {
    const extracted = provider === 'claude'
      ? extractClaudeAssistantMessage(message)
      : extractCodexAssistantMessage(message);
    if (extracted) {
      lastMessage = extracted;
    }
  }

  return lastMessage;
}
