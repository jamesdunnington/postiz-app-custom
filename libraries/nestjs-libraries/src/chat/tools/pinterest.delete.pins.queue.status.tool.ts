import { AgentToolInterface } from '@gitroom/nestjs-libraries/chat/agent.tool.interface';
import { createTool } from '@mastra/core/tools';
import { Injectable } from '@nestjs/common';
import z from 'zod';
import { checkAuth } from '@gitroom/nestjs-libraries/chat/auth.context';
import { PinterestDeleteService } from '@gitroom/nestjs-libraries/database/prisma/pinterest-delete/pinterest-delete.service';

@Injectable()
export class PinterestDeletePinsQueueStatusTool implements AgentToolInterface {
  constructor(private _pinterestDeleteService: PinterestDeleteService) {}
  name = 'pinterestDeletePinsQueueStatusTool';

  run() {
    return createTool({
      id: 'pinterestDeletePinsQueueStatusTool',
      description: `Read-only lookup of a Pinterest account's pin-deletion queue: how many pins are still queued, how many have been deleted, when the next deletion will run, and when the whole queue will finish draining (one pin every 50-60 minutes, randomized). Also returns any pins that failed to delete, with the reason. Does not submit or change anything.`,
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
          done: z.number(),
          totalEverSubmitted: z.number(),
          nextRunAt: z.string().nullable(),
          lastCompletionAt: z.string().nullable(),
          failed: z.array(
            z.object({
              pinId: z.string(),
              rawInput: z.string(),
              errorMessage: z.string().nullable(),
            })
          ),
        }),
      }),
      execute: async (args, options) => {
        const { context } = args;
        checkAuth(args, options);

        const summary = await this._pinterestDeleteService.listQueueSummary(
          context.integrationId
        );

        return {
          output: {
            queued: summary.queued,
            done: summary.done,
            totalEverSubmitted: summary.totalEverSubmitted,
            nextRunAt: summary.nextRunAt ? summary.nextRunAt.toISOString() : null,
            lastCompletionAt: summary.lastCompletionAt
              ? summary.lastCompletionAt.toISOString()
              : null,
            failed: summary.failed.map(({ pinId, rawInput, errorMessage }) => ({
              pinId,
              rawInput,
              errorMessage,
            })),
          },
        };
      },
    });
  }
}
