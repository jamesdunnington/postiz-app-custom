import { AgentToolInterface } from '@gitroom/nestjs-libraries/chat/agent.tool.interface';
import { createTool } from '@mastra/core/tools';
import { Injectable } from '@nestjs/common';
import z from 'zod';
import { checkAuth } from '@gitroom/nestjs-libraries/chat/auth.context';
import { PinterestDeleteService } from '@gitroom/nestjs-libraries/database/prisma/pinterest-delete/pinterest-delete.service';

@Injectable()
export class PinterestBulkDeletePinsTool implements AgentToolInterface {
  constructor(private _pinterestDeleteService: PinterestDeleteService) {}
  name = 'pinterestBulkDeletePinsTool';

  run() {
    return createTool({
      id: 'pinterestBulkDeletePinsTool',
      description: `Submits up to 100 Pinterest pins (by id or URL) for permanent deletion from a specific connected Pinterest account. This is irreversible and rate-limited (at most 100 actual deletions per account per rolling 24 hours; extra pins wait for the next window automatically) — always confirm with the user exactly which pins and which Pinterest account before calling this.`,
      inputSchema: z.object({
        integrationId: z
          .string()
          .describe(
            'The id of the Pinterest integration (not internal id), from integrationListTool'
          ),
        pins: z
          .array(z.string())
          .max(100)
          .describe(
            'Pinterest pin ids or pin URLs to delete, up to 100 per call'
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

        const result = await this._pinterestDeleteService.createBatch(
          organizationId,
          context.integrationId,
          null,
          'MCP',
          context.pins
        );

        return { output: result };
      },
    });
  }
}
