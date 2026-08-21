import { AgentToolInterface } from '@gitroom/nestjs-libraries/chat/agent.tool.interface';
import { createTool } from '@mastra/core/tools';
import { Injectable } from '@nestjs/common';
import { PostsService } from '@gitroom/nestjs-libraries/database/prisma/posts/posts.service';
import z from 'zod';
import { checkAuth } from '@gitroom/nestjs-libraries/chat/auth.context';

@Injectable()
export class IntegrationEditPostDateTool implements AgentToolInterface {
  constructor(private _postsService: PostsService) {}
  name = 'integrationEditPostDateTool';

  run() {
    return createTool({
      id: 'integrationEditPostDateTool',
      description: `Reschedules an existing post to a new date/time, without changing its content. Use integrationListPostsTool first to find the post's id. Always confirm the new date/time with the user before calling this.`,
      inputSchema: z.object({
        postId: z
          .string()
          .describe(
            'The id of the post to reschedule, from integrationListPostsTool'
          ),
        date: z
          .string()
          .describe('The new publish date/time, in UTC'),
      }),
      outputSchema: z.object({
        output: z.object({
          success: z.boolean(),
          publishDate: z.string().optional(),
        }),
      }),
      execute: async (args, options) => {
        const { context, runtimeContext } = args;
        checkAuth(args, options);
        const organizationId = JSON.parse(
          // @ts-ignore
          runtimeContext.get('organization') as string
        ).id;

        const result = await this._postsService.changeDate(
          organizationId,
          context.postId,
          context.date
        );

        return {
          output: result?.id
            ? {
                success: true,
                publishDate: result.publishDate?.toISOString(),
              }
            : { success: false },
        };
      },
    });
  }
}
