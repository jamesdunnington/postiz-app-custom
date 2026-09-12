import { AgentToolInterface } from '@gitroom/nestjs-libraries/chat/agent.tool.interface';
import { createTool } from '@mastra/core/tools';
import { Injectable } from '@nestjs/common';
import z from 'zod';
import { checkAuth } from '@gitroom/nestjs-libraries/chat/auth.context';
import { PinterestBoardDeleteService } from '@gitroom/nestjs-libraries/database/prisma/pinterest-board-delete/pinterest-board-delete.service';

@Injectable()
export class PinterestCancelQueuedBoardsTool implements AgentToolInterface {
  constructor(private _pinterestBoardDeleteService: PinterestBoardDeleteService) {}
  name = 'pinterestCancelQueuedBoardsTool';

  run() {
    return createTool({
      id: 'pinterestCancelQueuedBoardsTool',
      description: `Cancels one or more boards still sitting in a Pinterest account's board-deletion queue, before they're actually deleted. Use pinterestDeleteBoardsQueueStatusTool first to see the queued items (each has an "id") and confirm exactly which ones the user means. Only items still in PENDING status can be cancelled — anything already deleted or failed is untouched. This does not undo a deletion that already happened; it only stops ones that haven't fired yet.`,
      inputSchema: z.object({
        integrationId: z
          .string()
          .describe(
            'The id of the Pinterest integration (not internal id), from integrationListTool'
          ),
        itemIds: z
          .array(z.string())
          .max(25)
          .describe(
            'The "id" values (not board ids) of queued items to cancel, from pinterestDeleteBoardsQueueStatusTool\'s queuedItems list'
          ),
      }),
      outputSchema: z.object({
        output: z.object({
          cancelledIds: z.array(z.string()),
          cancelledCount: z.number(),
        }),
      }),
      execute: async (args, options) => {
        const { context, runtimeContext } = args;
        checkAuth(args, options);
        const organizationId = JSON.parse(
          // @ts-ignore
          runtimeContext.get('organization') as string
        ).id;

        const result = await this._pinterestBoardDeleteService.cancelItems(
          organizationId,
          context.integrationId,
          context.itemIds
        );

        return {
          output: {
            cancelledIds: result.cancelledIds,
            cancelledCount: result.cancelledIds.length,
          },
        };
      },
    });
  }
}
