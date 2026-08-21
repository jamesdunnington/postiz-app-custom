import { AgentToolInterface } from '@gitroom/nestjs-libraries/chat/agent.tool.interface';
import { createTool } from '@mastra/core/tools';
import { Injectable } from '@nestjs/common';
import { PostsService } from '@gitroom/nestjs-libraries/database/prisma/posts/posts.service';
import z from 'zod';
import { checkAuth } from '@gitroom/nestjs-libraries/chat/auth.context';

@Injectable()
export class IntegrationGetPostTool implements AgentToolInterface {
  constructor(private _postsService: PostsService) {}
  name = 'integrationGetPostTool';

  run() {
    return createTool({
      id: 'integrationGetPostTool',
      description: `Gets the full detail of one post, including every part of a thread (in order) with each part's own current publishDate and content. Use this after integrationListPostsTool (pass its "id" field) when you need to see all thread parts, not just the root — e.g. to check whether a thread's parts got separated onto different dates.`,
      inputSchema: z.object({
        postId: z
          .string()
          .describe('The root post id, from integrationListPostsTool'),
      }),
      outputSchema: z.object({
        output: z
          .object({
            group: z.string(),
            integrationId: z.string().optional(),
            parts: z.array(
              z.object({
                id: z.string(),
                partIndex: z.number(),
                state: z.string(),
                publishDate: z.string(),
                content: z.string(),
              })
            ),
          })
          .or(z.object({ errors: z.string() })),
      }),
      execute: async (args, options) => {
        const { context, runtimeContext } = args;
        checkAuth(args, options);
        const organizationId = JSON.parse(
          // @ts-ignore
          runtimeContext.get('organization') as string
        ).id;

        const existing = await this._postsService.getPost(
          organizationId,
          context.postId
        );

        if (!existing?.posts?.length) {
          return { output: { errors: `Post ${context.postId} not found` } };
        }

        return {
          output: {
            group: existing.group,
            integrationId: existing.integration,
            parts: existing.posts.map((p: any, index: number) => ({
              id: p.id,
              partIndex: index,
              state: p.state,
              publishDate: new Date(p.publishDate).toISOString(),
              content: p.content,
            })),
          },
        };
      },
    });
  }
}
