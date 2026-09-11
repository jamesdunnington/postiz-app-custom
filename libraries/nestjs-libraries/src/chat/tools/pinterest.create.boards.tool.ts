import { AgentToolInterface } from '@gitroom/nestjs-libraries/chat/agent.tool.interface';
import { createTool } from '@mastra/core/tools';
import { Injectable } from '@nestjs/common';
import z from 'zod';
import { checkAuth } from '@gitroom/nestjs-libraries/chat/auth.context';
import { PinterestBoardsService } from '@gitroom/nestjs-libraries/database/prisma/pinterest-boards/pinterest-boards.service';

@Injectable()
export class PinterestCreateBoardsTool implements AgentToolInterface {
  constructor(private _pinterestBoardsService: PinterestBoardsService) {}
  name = 'pinterestCreateBoardsTool';

  run() {
    return createTool({
      id: 'pinterestCreateBoardsTool',
      description: `Creates up to 50 new boards on a specific connected Pinterest account. Low-risk and easy to undo (a board with nothing pinned to it can just be deleted again) — still confirm the board names and account with the user before calling this, but this does not need the same caution as the deletion tools.`,
      inputSchema: z.object({
        integrationId: z
          .string()
          .describe(
            'The id of the Pinterest integration (not internal id), from integrationListTool'
          ),
        boards: z
          .array(
            z.object({
              name: z.string().max(180).describe('Board name'),
              description: z
                .string()
                .max(500)
                .optional()
                .describe('Optional board description'),
              isPrivate: z
                .boolean()
                .optional()
                .describe('Create as a secret/private board (default: public)'),
            })
          )
          .max(50)
          .describe('Boards to create, up to 50 per call'),
      }),
      outputSchema: z.object({
        output: z.object({
          results: z.array(
            z.object({
              name: z.string(),
              boardId: z.string().optional(),
              error: z.string().optional(),
            })
          ),
        }),
      }),
      execute: async (args, options) => {
        const { context, runtimeContext } = args;
        checkAuth(args, options);
        const organizationId = JSON.parse(
          // @ts-ignore
          runtimeContext.get('organization') as string
        ).id;

        const results = await this._pinterestBoardsService.createBoards(
          organizationId,
          context.integrationId,
          context.boards
        );

        return { output: { results } };
      },
    });
  }
}
