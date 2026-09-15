import { AgentToolInterface } from '@gitroom/nestjs-libraries/chat/agent.tool.interface';
import { createTool } from '@mastra/core/tools';
import { Injectable } from '@nestjs/common';
import z from 'zod';
import { checkAuth } from '@gitroom/nestjs-libraries/chat/auth.context';
import { PinterestMoveService } from '@gitroom/nestjs-libraries/database/prisma/pinterest-move/pinterest-move.service';

@Injectable()
export class PinterestBulkMovePinsTool implements AgentToolInterface {
  constructor(private _pinterestMoveService: PinterestMoveService) {}
  name = 'pinterestBulkMovePinsTool';

  run() {
    return createTool({
      id: 'pinterestBulkMovePinsTool',
      description: `Submits up to 200 Pinterest pins (by id or URL) to be moved (not deleted) to a given target board on a specific connected Pinterest account. Moving preserves the pin's saves/engagement, unlike deletion. This is paced deliberately slowly — one pin is actually moved every 50-60 minutes per account by default (randomized, configurable), so a large call can take a long time to fully drain; submitting more pins later appends to that account's ongoing queue rather than starting a second one. Once a pin is moved it stays on the new board until manually moved again — always confirm with the user exactly which pins, which target board, and which Pinterest account before calling this.`,
      inputSchema: z.object({
        integrationId: z
          .string()
          .describe(
            'The id of the Pinterest integration (not internal id), from integrationListTool'
          ),
        targetBoardId: z
          .string()
          .describe(
            'The id of the Pinterest board every submitted pin should be moved to'
          ),
        pins: z
          .array(z.string())
          .max(200)
          .describe(
            'Pinterest pin ids or pin URLs to move, up to 200 per call — they drain from the queue one at a time, roughly every 50-60 minutes per account'
          ),
      }),
      outputSchema: z.object({
        output: z.object({
          batchId: z.string(),
          submittedCount: z.number(),
        }),
      }),
      execute: async (args, options) => {
        const { context, runtimeContext } = args;
        checkAuth(args, options);
        const organizationId = JSON.parse(
          // @ts-ignore
          runtimeContext.get('organization') as string
        ).id;

        const result = await this._pinterestMoveService.createBatch(
          organizationId,
          context.integrationId,
          null,
          'MCP',
          context.targetBoardId,
          undefined,
          context.pins
        );

        return { output: result };
      },
    });
  }
}
