import { Inject, Injectable, Logger } from '@nestjs/common';
import OpenAI from 'openai';
import type { ChatCompletionMessageParam, ChatCompletionTool } from 'openai/resources/chat/completions';
import { ENV } from '@config/config.module';
import type { Env } from '@config/env';
import { BusinessException } from '@common/exception/business.exception';
import { AI_ERR, AI_PROVIDER } from '../foundation/ai.constants';
import { AiUsageService } from '../usage/ai-usage.service';

export type ChatMessageParam = ChatCompletionMessageParam;
export type ChatToolSpec = ChatCompletionTool;

export interface AgentToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface AgentResult {
  text: string;
  toolsUsed: string[];
  rounds: number;
  tokensIn: number;
  tokensOut: number;
  model: string;
}

export interface ChatJsonResult<T> {
  data: T;
  tokensIn: number;
  tokensOut: number;
  model: string;
}

/*
 * Bọc OpenAI SDK — CHỖ DUY NHẤT gọi OpenAI. Không có key → `isConfigured=false`, caller dùng đường lùi.
 * Mỗi lần gọi: kiểm ngân sách trước, ghi usage sau (kể cả lỗi). Không log key/prompt chứa PII.
 */
@Injectable()
export class OpenAiProvider {
  private readonly logger = new Logger(OpenAiProvider.name);
  private readonly client: OpenAI | null;

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly usage: AiUsageService,
  ) {
    this.client = env.EF_OPENAI_API_KEY ? new OpenAI({ apiKey: env.EF_OPENAI_API_KEY, timeout: 60_000, maxRetries: 1 }) : null;
    if (!this.client) this.logger.warn('EF_OPENAI_API_KEY trống — chatbot/phân tích ảnh chạy đường lùi (rule), không nhúng sản phẩm');
  }

  get isConfigured(): boolean {
    return this.client !== null;
  }

  get embeddingModel(): string {
    return this.env.EF_OPENAI_EMBEDDING_MODEL;
  }

  private require(): OpenAI {
    if (!this.client) throw new BusinessException(AI_ERR.NOT_CONFIGURED, 'Dịch vụ AI chưa được cấu hình', 503);
    return this.client;
  }

  /* Nhúng nhiều đoạn text (≤ 2048 đoạn/lần theo OpenAI; ta gửi ≤ 100 cho chắc). */
  async embed(texts: string[], feature: string, userId?: string | null): Promise<number[][]> {
    const client = this.require();
    if (texts.length === 0) return [];
    await this.usage.assertBudget();
    const model = this.env.EF_OPENAI_EMBEDDING_MODEL;
    const t0 = Date.now();
    try {
      const out: number[][] = [];
      for (let i = 0; i < texts.length; i += 100) {
        const batch = texts.slice(i, i + 100).map((t) => t.slice(0, 8000));
        const res = await client.embeddings.create({ model, input: batch });
        for (const d of res.data) out.push(d.embedding);
        await this.usage.record({ feature, provider: AI_PROVIDER.OPENAI, model, tokensIn: res.usage?.prompt_tokens ?? 0, durationMs: Date.now() - t0, success: true, userId });
      }
      return out;
    } catch (err) {
      await this.usage.record({ feature, provider: AI_PROVIDER.OPENAI, model, durationMs: Date.now() - t0, success: false, userId });
      this.logger.warn({ err: (err as Error).message, feature }, 'OpenAI embeddings lỗi');
      throw new BusinessException(AI_ERR.PROVIDER_FAILED, 'Dịch vụ AI tạm thời không phản hồi', 503);
    }
  }

  /* Chat trả JSON (response_format json_object) — prompt hệ thống PHẢI nhắc "trả JSON". */
  async chatJson<T>(messages: ChatMessageParam[], opts: { feature: string; userId?: string | null; model?: string; maxTokens?: number; temperature?: number }): Promise<ChatJsonResult<T>> {
    const client = this.require();
    await this.usage.assertBudget();
    const model = opts.model ?? this.env.EF_OPENAI_CHAT_MODEL;
    const t0 = Date.now();
    try {
      const res = await client.chat.completions.create({ model, messages, response_format: { type: 'json_object' }, max_completion_tokens: opts.maxTokens ?? 800, ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}) });
      const tokensIn = res.usage?.prompt_tokens ?? 0;
      const tokensOut = res.usage?.completion_tokens ?? 0;
      await this.usage.record({ feature: opts.feature, provider: AI_PROVIDER.OPENAI, model, tokensIn, tokensOut, durationMs: Date.now() - t0, success: true, userId: opts.userId });
      const raw = res.choices[0]?.message?.content ?? '{}';
      return { data: JSON.parse(raw) as T, tokensIn, tokensOut, model };
    } catch (err) {
      await this.usage.record({ feature: opts.feature, provider: AI_PROVIDER.OPENAI, model, durationMs: Date.now() - t0, success: false, userId: opts.userId });
      if (err instanceof BusinessException) throw err;
      this.logger.warn({ err: (err as Error).message, feature: opts.feature }, 'OpenAI chat lỗi');
      throw new BusinessException(AI_ERR.PROVIDER_FAILED, 'Dịch vụ AI tạm thời không phản hồi', 503);
    }
  }

  /*
   * Vòng AGENT tool-calling (không stream): model chọn tool → ta chạy `execute` → trả kết quả → lặp tới khi model
   * trả lời chữ hoặc hết `maxRounds`. Model KHÔNG bao giờ chạm DB — mọi số liệu đi qua tool đã có luật.
   */
  async runAgent(messages: ChatMessageParam[], tools: ChatToolSpec[], execute: (call: AgentToolCall) => Promise<string>, opts: { feature: string; userId?: string | null; maxRounds?: number; maxTokens?: number; temperature?: number }): Promise<AgentResult> {
    const client = this.require();
    await this.usage.assertBudget();
    const model = this.env.EF_OPENAI_CHAT_MODEL;
    const history: ChatMessageParam[] = [...messages];
    const toolsUsed: string[] = [];
    let tokensIn = 0;
    let tokensOut = 0;
    const t0 = Date.now();
    const maxRounds = opts.maxRounds ?? 4;
    try {
      for (let round = 1; round <= maxRounds + 1; round++) {
        const last = round > maxRounds;
        const res = await client.chat.completions.create({ model, messages: history, tools: last ? undefined : tools, tool_choice: last ? undefined : 'auto', max_completion_tokens: opts.maxTokens ?? 700, ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}) });
        tokensIn += res.usage?.prompt_tokens ?? 0;
        tokensOut += res.usage?.completion_tokens ?? 0;
        const msg = res.choices[0]?.message;
        const calls = msg?.tool_calls?.filter((c) => c.type === 'function') ?? [];
        if (!msg || calls.length === 0) {
          await this.usage.record({ feature: opts.feature, provider: AI_PROVIDER.OPENAI, model, tokensIn, tokensOut, durationMs: Date.now() - t0, success: true, userId: opts.userId });
          return { text: (msg?.content ?? '').trim(), toolsUsed, rounds: round, tokensIn, tokensOut, model };
        }
        history.push({ role: 'assistant', content: msg.content ?? '', tool_calls: msg.tool_calls });
        for (const c of calls) {
          if (c.type !== 'function') continue;
          let args: Record<string, unknown> = {};
          try {
            args = c.function.arguments ? (JSON.parse(c.function.arguments) as Record<string, unknown>) : {};
          } catch {
            args = {};
          }
          toolsUsed.push(c.function.name);
          let out: string;
          try {
            out = await execute({ id: c.id, name: c.function.name, args });
          } catch (err) {
            out = JSON.stringify({ error: (err as Error).message.slice(0, 300) });
          }
          history.push({ role: 'tool', tool_call_id: c.id, content: out.slice(0, 12_000) });
        }
      }
      throw new Error('agent quá số vòng');
    } catch (err) {
      await this.usage.record({ feature: opts.feature, provider: AI_PROVIDER.OPENAI, model, tokensIn, tokensOut, durationMs: Date.now() - t0, success: false, userId: opts.userId });
      if (err instanceof BusinessException) throw err;
      this.logger.warn({ err: (err as Error).message, feature: opts.feature }, 'OpenAI agent lỗi');
      throw new BusinessException(AI_ERR.PROVIDER_FAILED, 'Dịch vụ AI tạm thời không phản hồi', 503);
    }
  }

  /* Phân tích ảnh (vision) trả JSON. */
  visionJson<T>(imageUrl: string, system: string, userText: string, opts: { feature: string; userId?: string | null; maxTokens?: number }): Promise<ChatJsonResult<T>> {
    return this.chatJson<T>(
      [
        { role: 'system', content: system },
        { role: 'user', content: [{ type: 'text', text: userText }, { type: 'image_url', image_url: { url: imageUrl, detail: 'low' } }] },
      ],
      { feature: opts.feature, userId: opts.userId, model: this.env.EF_OPENAI_VISION_MODEL, maxTokens: opts.maxTokens ?? 700 },
    );
  }
}
