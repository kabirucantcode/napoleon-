import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  InternalServerErrorException,
  Logger,
  Param,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { ApiKeyGuard } from '../auth/api-key.guard';
import { CurrentPrincipal } from '../auth/current-principal.decorator';
import { estimateTokens, OpenAiRenderer } from '../openai/openai.renderer';
import { ConversationsService, type ChatTurn } from './conversations.service';
import type { Principal } from '../auth/principal';

/**
 * OpenAI-compatible surface.
 *
 * Routes are unprefixed (`POST /api/v1/chat/completions`) so an OpenAI client is
 * pointed straight at the API root:
 *
 *   new OpenAI({ baseURL: 'https://host/api/v1', apiKey: 'sk_napoleon_…' })
 *
 * Napoleon is not a language model. The "answer" is the engine's output rendered
 * as markdown, with the structured payload alongside it so a real application
 * can read numbers instead of parsing prose.
 */
@Controller()
export class OpenAiController {
  private readonly logger = new Logger(OpenAiController.name);

  constructor(
    private readonly renderer: OpenAiRenderer,
    private readonly conversations: ConversationsService,
  ) {}

  /** Unauthenticated, so a caller can verify the base URL before wiring a key. */
  @Get('models')
  models() {
    return this.renderer.listModels();
  }

  /**
   * Body follows the OpenAI contract. Only `model` and `messages` are read;
   * every other OpenAI field (temperature, top_p, max_tokens, tools, ...) is
   * accepted and ignored rather than rejected, so real SDK calls do not 400.
   */
  @Post('chat/completions')
  @UseGuards(ApiKeyGuard)
  async chatCompletions(
    @CurrentPrincipal() principal: Principal,
    @Body() body: Record<string, unknown>,
    @Res() res: Response,
  ): Promise<void> {
    const messages = this.validateMessages(body?.messages);
    const model =
      typeof body?.model === 'string' && body.model.trim()
        ? body.model.trim()
        : 'napoleon-1';

    if (body?.n !== undefined && Number(body.n) > 1) {
      throw this.invalid(
        '`n` greater than 1 is not supported — there is one correct analysis.',
        'n',
      );
    }

    const prompt =
      [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';
    const intent = this.renderer.resolveIntent(model, prompt);

    let analysis: unknown;
    try {
      analysis = await this.renderer.analyze(principal.organizationId, intent);
    } catch (err) {
      this.logger.error(
        `Analysis failed (org=${principal.organizationId}, intent=${intent})`,
        err instanceof Error ? err.stack : String(err),
      );
      throw new InternalServerErrorException({
        error: {
          message: 'Napoleon could not compute this analysis. Please retry.',
          type: 'server_error',
          param: null,
          code: null,
        },
      });
    }

    const content = this.renderer.render(intent, analysis);
    const completion = this.renderer.buildCompletion({
      id: this.renderer.newCompletionId(),
      created: Math.floor(Date.now() / 1000),
      model,
      intent,
      data: analysis,
      content,
      promptTokens: this.renderer.estimatePromptTokens(messages),
    });

    const conversationId = await this.conversations.record(
      principal.organizationId,
      typeof body?.conversation_id === 'string' ? body.conversation_id : null,
      messages,
      completion,
      intent,
      estimateTokens,
    );

    const wantsStream = body?.stream === true || body?.stream === 'true';
    if (!wantsStream) {
      res.json({ ...completion, napoleon_conversation_id: conversationId });
      return;
    }

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    for (const frame of this.renderer.streamChunks(completion, conversationId)) {
      res.write(frame);
    }
    res.end();
  }

  @Get('conversations')
  @UseGuards(ApiKeyGuard)
  listConversations(
    @CurrentPrincipal() principal: Principal,
    @Query('limit') limit?: string,
  ) {
    const take = Math.min(Math.max(parseInt(limit ?? '20', 10) || 20, 1), 100);
    return this.conversations.list(principal.organizationId, take);
  }

  @Get('conversations/:id')
  @UseGuards(ApiKeyGuard)
  getConversation(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
  ) {
    return this.conversations.get(principal.organizationId, id);
  }

  @Delete('conversations/:id')
  @UseGuards(ApiKeyGuard)
  deleteConversation(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
  ) {
    return this.conversations.remove(principal.organizationId, id);
  }

  // ── Validation ──────────────────────────────────────────────────────────

  private validateMessages(raw: unknown): ChatTurn[] {
    if (!Array.isArray(raw) || raw.length === 0) {
      throw this.invalid(
        '`messages` is required and must be a non-empty array.',
        'messages',
      );
    }
    return raw.map((m, i) => {
      const msg = m as { role?: unknown; content?: unknown };
      if (!msg || typeof msg.role !== 'string' || !msg.role) {
        throw this.invalid(
          `\`messages[${i}].role\` must be a non-empty string.`,
          `messages[${i}].role`,
        );
      }
      if (typeof msg.content !== 'string' && !Array.isArray(msg.content)) {
        throw this.invalid(
          `\`messages[${i}].content\` must be a string or an array of parts.`,
          `messages[${i}].content`,
        );
      }
      return { role: msg.role, content: this.toText(msg.content) };
    });
  }

  /** Flatten multimodal content parts into plain text. */
  private toText(content: unknown): string {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content
        .map((part) => {
          if (typeof part === 'string') return part;
          const p = part as { text?: unknown };
          return typeof p?.text === 'string' ? p.text : '';
        })
        .filter(Boolean)
        .join('\n');
    }
    return content == null ? '' : String(content);
  }

  /** OpenAI-shaped error envelope, so client SDKs render it correctly. */
  private invalid(message: string, param: string | null) {
    return new BadRequestException({
      error: { message, type: 'invalid_request_error', param, code: null },
    });
  }
}
