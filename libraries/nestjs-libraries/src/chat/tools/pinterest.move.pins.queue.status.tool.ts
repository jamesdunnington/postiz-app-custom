import { AgentToolInterface } from '@gitroom/nestjs-libraries/chat/agent.tool.interface';
import { createTool } from '@mastra/core/tools';
import { Injectable } from '@nestjs/common';
import z from 'zod';
import { checkAuth } from '@gitroom/nestjs-libraries/chat/auth.context';
import { PinterestMoveService } from '@gitroom/nestjs-libraries/database/prisma/pinterest-move/pinterest-move.service';

@Injectable()
export class PinterestMovePinsQueueStatusTool implements AgentToolInterface {
  constructor(private _pinterestMoveService: PinterestMoveService) {}
  name = 'pinterestMovePinsQueueStatusTool';

  run() {
    return createTool({
      id: 'pinterestMovePinsQueueStatusTool',
      description: `Read-only lookup of a Pinterest account's pin-move queue: how many pins are still queued, how many have been moved, when the next move will run, and when the whole queue will finish draining (one pin every 50-60 minutes, randomized). Also returns any pins that failed to move, with the reason. Does not submit or change anything.`,
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
              pinId: z.string(),
              rawInput: z.string(),
              targetBoardId: z.string(),
              targetBoardName: z.string(),
              scheduledFor: z.string().nullable(),
            })
          ),
          done: z.number(),
          totalEverSubmitted: z.number(),
          nextRunAt: z.string().nullable(),
          lastCompletionAt: z.string().nullable(),
          failed: z.array(
            z.object({
              pinId: z.string(),
              rawInput: z.string(),
              targetBoardId: z.string(),
              targetBoardName: z.string(),
              errorMessage: z.string().nullable(),
            })
          ),
        }),
      }),
      execute: async (args, options) => {
        const { context } = args;
        checkAuth(args, options);

        const summary = await this._pinterestMoveService.listQueueSummary(
          context.integrationId
        );

        return {
          output: {
            queued: summary.queued,
            queuedItems: summary.queuedItems.map(
              ({ id, pinId, rawInput, targetBoardId, targetBoardName, scheduledFor }) => ({
                id,
                pinId,
                rawInput,
                targetBoardId,
                targetBoardName,
                scheduledFor: scheduledFor ? scheduledFor.toISOString() : null,
              })
            ),
            done: summary.done,
            totalEverSubmitted: summary.totalEverSubmitted,
            nextRunAt: summary.nextRunAt ? summary.nextRunAt.toISOString() : null,
            lastCompletionAt: summary.lastCompletionAt
              ? summary.lastCompletionAt.toISOString()
              : null,
            failed: summary.failed.map(
              ({ pinId, rawInput, targetBoardId, targetBoardName, errorMessage }) => ({
                pinId,
                rawInput,
                targetBoardId,
                targetBoardName,
                errorMessage,
              })
            ),
          },
        };
      },
    });
  }
}
