import type { ChatActionResult } from './chat-action.service';

export interface ChatActionView {
  id: string;
  kind: string;
  summary: string;
  params: Record<string, unknown>;
}

/* `chat_messages.meta` của câu trả lời trợ lý — tool đã dùng, tool trả rỗng (bot bí), gợi ý, đề xuất hành động, guard. */
export interface MessageMeta {
  tools?: string[];
  misses?: string[];
  suggestions?: string[];
  actions?: ChatActionView[];
  supportRequestId?: string | null;
  guard?: string | null;
  contextProductSlug?: string | null;
  actionResult?: ChatActionResult;
  model?: string;
}
