import { AgentToolInterface } from '@gitroom/nestjs-libraries/chat/agent.tool.interface';
import { createTool } from '@mastra/core/tools';
import { Injectable } from '@nestjs/common';
import z from 'zod';
import { checkAuth } from '@gitroom/nestjs-libraries/chat/auth.context';
import { PinterestBoardDeleteService } from '@gitroom/nestjs-libraries/database/prisma/pinterest-board-delete/pinterest-board-delete.service';

@Injectable()
export class PinterestDeleteBoardsQueueStatusTool implements AgentToolInterface {
  constructor(private _pinterestBoardDeleteService: PinterestBoardDeleteService) {}
  name = 'pinterestDeleteBoardsQueueStatusTool';

  run() {
    return createTool({
      id: 'pinterestDeleteBoardsQueueStatusTool',
      description: `Read-only lookup of a Pinterest account's board-deletion queue: how many boards are still queued, how many have been deleted, when the next deletion will run, and when the whole queue will finish draining (one board every 300-320 minutes, randomized). Also returns any boards that failed to delete, with the reason. For the full per-board Pending/Deleted/Failed breakdown, check the Board Deletion tab in the app — this returns aggregate counts and failures only. Does not submit or change anything.`,
      inputSchema: z.object({
        integrationId: z
          .string()
          .describe(
            'The id of the Pinterest integration (not internal id), from integrationListTool'
          ),
      }),
      outputSchema: z.object({
        output: z.object({
          queued: z.number(),
          queuedItems: z.array(
            z.object({
              id: z.string(),
              boardId: z.string(),
              boardName: z.string(),
              scheduledFor: z.string().nullable(),
            })
          ),
          done: z.number(),
          totalEverSubmitted: z.number(),
          nextRunAt: z.string().nullable(),
          lastCompletionAt: z.string().nullable(),
          failed: z.array(
            z.object({
              boardId: z.string(),
              boardName: z.string(),
              errorMessage: z.string().nullable(),
            })
          ),
        }),
      }),
      execute: async (args, options) => {
        const { context } = args;
        checkAuth(args, options);

        const summary = await this._pinterestBoardDeleteService.listQueueSummary(
          context.integrationId
        );

        return {
          output: {
            queued: summary.queued,
            queuedItems: summary.items
              .filter((i) => i.status === 'PENDING')
              .map(({ id, boardId, boardName, scheduledFor }) => ({
                id,
                boardId,
                boardName,
                scheduledFor: scheduledFor ? scheduledFor.toISOString() : null,
              })),
            done: summary.done,
            totalEverSubmitted: summary.totalEverSubmitted,
            nextRunAt: summary.nextRunAt ? summary.nextRunAt.toISOString() : null,
            lastCompletionAt: summary.lastCompletionAt
              ? summary.lastCompletionAt.toISOString()
              : null,
            failed: summary.failed.map(({ boardId, boardName, errorMessage }) => ({
              boardId,
              boardName,
              errorMessage,
            })),
          },
        };
      },
    });
  }
}
