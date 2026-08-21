import { AgentToolInterface } from '@gitroom/nestjs-libraries/chat/agent.tool.interface';
import { createTool } from '@mastra/core/tools';
import { Injectable } from '@nestjs/common';
import { PostsService } from '@gitroom/nestjs-libraries/database/prisma/posts/posts.service';
import z from 'zod';
import { checkAuth } from '@gitroom/nestjs-libraries/chat/auth.context';

@Injectable()
export class IntegrationDeletePostTool implements AgentToolInterface {
  constructor(private _postsService: PostsService) {}
  name = 'integrationDeletePostTool';

  run() {
    return createTool({
      id: 'integrationDeletePostTool',
      description: `Permanently deletes/cancels a scheduled, draft, or published post (and, for a thread, every part of it). This is irreversible — always confirm with the user which exact post they mean (show them its date and content preview from integrationListPostsTool) before calling this.`,
      inputSchema: z.object({
        group: z
          .string()
          .describe(
            'The group id of the post to delete, from integrationListPostsTool'
          ),
      }),
      outputSchema: z.object({
        output: z.object({
          success: z.boolean(),
          id: z.string().optional(),
        }),
      }),
      execute: async (args, options) => {
        const { context, runtimeContext } = args;
        checkAuth(args, options);
        const organizationId = JSON.parse(
          // @ts-ignore
          runtimeContext.get('organization') as string
        ).id;

        const result = await this._postsService.deletePost(
          organizationId,
          context.group
        );

        return {
          output: result?.id
            ? { success: true, id: result.id }
            : { success: false },
        };
      },
    });
  }
}
