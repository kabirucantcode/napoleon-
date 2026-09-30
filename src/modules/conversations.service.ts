import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';

interface CompletionForStorage {
  id: string;
  choices: {
    message: { content: string; napoleon: { intent: string } };
  }[];
}

export interface ChatTurn {
  role: string;
  content: string;
}

/**
 * Transcripts of the OpenAI-compatible surface.
 *
 * Kept for two reasons beyond logging: which sites an operator scrutinises is
 * itself signal, and a learned ranking model will need a record of what was
 * shown and when. Writes are best-effort — a storage failure must never fail the
 * caller's analysis.
 */
@Injectable()
export class ConversationsService {
  private readonly logger = new Logger(ConversationsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async record(
    organizationId: string,
    conversationId: string | null,
    turns: ChatTurn[],
    completion: CompletionForStorage,
    intent: string,
    estimateTokens: (text: string) => number,
  ): Promise<string | null> {
    try {
      let conversation = conversationId
        ? await this.prisma.conversation.findFirst({
            where: { id: conversationId, organizationId },
            select: { id: true },
          })
        : null;

      if (!conversation) {
        const firstUser = turns.find((t) => t.role === 'user');
        conversation = await this.prisma.conversation.create({
          data: {
            organizationId,
            title: (firstUser?.content ?? 'Napoleon conversation').slice(0, 120),
          },
          select: { id: true },
        });
      }

      const assistant = completion.choices[0].message;
      await this.prisma.message.createMany({
        data: [
          ...turns.map((turn) => ({
            conversationId: conversation.id,
            role: turn.role,
            content: turn.content,
            tokens: estimateTokens(turn.content),
          })),
          {
            conversationId: conversation.id,
            role: 'assistant',
            content: assistant.content,
            intent,
            tokens: estimateTokens(assistant.content),
          },
        ],
      });

      await this.prisma.conversation.update({
        where: { id: conversation.id },
        data: { updatedAt: new Date() },
      });

      return conversation.id;
    } catch (err) {
      this.logger.warn(
        `Failed to persist conversation: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return null;
    }
  }

  async list(organizationId: string, limit = 20) {
    return this.prisma.conversation.findMany({
      where: { organizationId },
      orderBy: { updatedAt: 'desc' },
      take: limit,
      select: {
        id: true,
        title: true,
        createdAt: true,
        updatedAt: true,
        _count: { select: { messages: true } },
      },
    });
  }

  async get(organizationId: string, id: string) {
    const conversation = await this.prisma.conversation.findFirst({
      where: { id, organizationId },
      include: { messages: { orderBy: { createdAt: 'asc' } } },
    });
    if (!conversation) throw new NotFoundException('Conversation not found');
    return conversation;
  }

  async remove(organizationId: string, id: string) {
    const result = await this.prisma.conversation.deleteMany({
      where: { id, organizationId },
    });
    if (result.count === 0) {
      throw new NotFoundException('Conversation not found');
    }
    return { success: true };
  }
}
