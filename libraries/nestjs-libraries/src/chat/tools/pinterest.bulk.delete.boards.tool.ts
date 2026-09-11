import { AgentToolInterface } from '@gitroom/nestjs-libraries/chat/agent.tool.interface';
import { createTool } from '@mastra/core/tools';
import { Injectable } from '@nestjs/common';
import z from 'zod';
import { checkAuth } from '@gitroom/nestjs-libraries/chat/auth.context';
import { PinterestBoardDeleteService } from '@gitroom/nestjs-libraries/database/prisma/pinterest-board-delete/pinterest-board-delete.service';

@Injectable()
export class PinterestBulkDeleteBoardsTool implements AgentToolInterface {
  constructor(private _pinterestBoardDeleteService: PinterestBoardDeleteService) {}
  name = 'pinterestBulkDeleteBoardsTool';

  run() {
    return createTool({
      id: 'pinterestBulkDeleteBoardsTool',
      description: `Queues up to 25 Pinterest boards (by exact name, including archived boards) for permanent deletion from a specific connected Pinterest account. This is far more destructive than deleting a single pin — it removes the board and everything pinned to it — and is irreversible. It is also paced deliberately slowly: one board is actually deleted every 300-320 minutes (5-5.3 hours, randomized) per account, so a batch can take days to fully drain; submitting more boards later appends to that account's ongoing queue rather than starting a second one. Board names are matched case-insensitively and exactly — anything that doesn't match is reported back as not found rather than guessed at. Always confirm the exact board names and account with the user before calling this.`,
      inputSchema: z.object({
        integrationId: z
          .string()
          .describe(
            'The id of the Pinterest integration (not internal id), from integrationListTool'
          ),
        boardNames: z
          .array(z.string())
          .max(25)
          .describe(
            'Exact Pinterest board names to delete, up to 25 per call — matched case-insensitively, including archived boards'
          ),
      }),
      outputSchema: z.object({
        output: z.object({
          batchId: z.string().optional(),
          submittedCount: z.number(),
          notFound: z.array(z.string()),
        }),
      }),
      execute: async (args, options) => {
        const { context, runtimeContext } = args;
        checkAuth(args, options);
        const organizationId = JSON.parse(
          // @ts-ignore
          runtimeContext.get('organization') as string
        ).id;

        const { matched, notFound } =
          await this._pinterestBoardDeleteService.resolveBoardIdsByName(
            organizationId,
            context.integrationId,
            context.boardNames
          );

        if (matched.length === 0) {
          return { output: { submittedCount: 0, notFound } };
        }

        const result = await this._pinterestBoardDeleteService.createBatch(
          organizationId,
          context.integrationId,
          null,
          matched
        );

        return { output: { ...result, notFound } };
      },
    });
  }
}
