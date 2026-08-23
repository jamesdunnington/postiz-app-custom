import { AgentToolInterface } from '@gitroom/nestjs-libraries/chat/agent.tool.interface';
import { createTool } from '@mastra/core/tools';
import { Injectable } from '@nestjs/common';
import { PostsService } from '@gitroom/nestjs-libraries/database/prisma/posts/posts.service';
import z from 'zod';
import { checkAuth } from '@gitroom/nestjs-libraries/chat/auth.context';

@Injectable()
export class IntegrationGetGroupHistoryTool implements AgentToolInterface {
  constructor(private _postsService: PostsService) {}
  name = 'integrationGetGroupHistoryTool';

  run() {
    return createTool({
      id: 'integrationGetGroupHistoryTool',
      description: `Diagnostic tool: lists every post row ever created under a given group id, including soft-deleted or orphaned ones the normal tools hide. Use this when a thread's parts seem to have disappeared (not just moved) to trace what actually happened to them. Get the group id from integrationGetPostTool or integrationListPostsTool.`,
      inputSchema: z.object({
        group: z.string().describe('The group id to trace'),
      }),
      outputSchema: z.object({
        output: z.array(
          z.object({
            id: z.string(),
            parentPostId: z.string().nullable(),
            state: z.string(),
            publishDate: z.string(),
            createdAt: z.string(),
            deletedAt: z.string().nullable(),
            content: z.string(),
          })
        ),
      }),
      execute: async (args, options) => {
        const { context, runtimeContext } = args;
        checkAuth(args, options);
        const organizationId = JSON.parse(
          // @ts-ignore
          runtimeContext.get('organization') as string
        ).id;

        const rows = await this._postsService.getGroupHistory(
          organizationId,
          context.group
        );

        return {
          output: (rows || []).map((r: any) => ({
            id: r.id,
            parentPostId: r.parentPostId,
            state: r.state,
            publishDate: new Date(r.publishDate).toISOString(),
            createdAt: new Date(r.createdAt).toISOString(),
            deletedAt: r.deletedAt ? new Date(r.deletedAt).toISOString() : null,
            content: r.content,
          })),
        };
      },
    });
  }
}
