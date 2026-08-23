import { AgentToolInterface } from '@gitroom/nestjs-libraries/chat/agent.tool.interface';
import { createTool } from '@mastra/core/tools';
import { Injectable } from '@nestjs/common';
import { PostsService } from '@gitroom/nestjs-libraries/database/prisma/posts/posts.service';
import z from 'zod';
import { checkAuth } from '@gitroom/nestjs-libraries/chat/auth.context';

@Injectable()
export class IntegrationListPostsTool implements AgentToolInterface {
  constructor(private _postsService: PostsService) {}
  name = 'integrationListPostsTool';

  run() {
    return createTool({
      id: 'integrationListPostsTool',
      description: `Lists your scheduled/draft/published posts within a date range, optionally filtered to one integration (channel). Use this to find a post's id/group before editing its date or deleting it.`,
      inputSchema: z.object({
        startDate: z
          .string()
          .describe('Start of the date range, ISO date (e.g. 2026-08-21)'),
        endDate: z
          .string()
          .describe('End of the date range, ISO date (e.g. 2026-09-21)'),
        integrationId: z
          .string()
          .optional()
          .describe(
            'Only return posts for this integration id (from integrationList)'
          ),
      }),
      outputSchema: z.object({
        output: z.array(
          z.object({
            id: z.string(),
            group: z.string(),
            state: z.string(),
            publishDate: z.string(),
            content: z.string(),
            integrationId: z.string().optional(),
            integrationName: z.string().optional(),
            platform: z.string().optional(),
            hasAttachments: z.boolean(),
            attachmentCount: z.number(),
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

        const posts = await this._postsService.getPosts(organizationId, {
          startDate: context.startDate,
          endDate: context.endDate,
        } as any);

        return {
          output: (posts || [])
            .filter(
              (p: any) =>
                !context.integrationId ||
                p.integration?.id === context.integrationId
            )
            .map((p: any) => {
              let attachmentCount = 0;
              try {
                attachmentCount = (JSON.parse(p.image || '[]') || []).length;
              } catch {
                attachmentCount = 0;
              }

              return {
                id: p.id,
                group: p.group,
                state: p.state,
                publishDate: new Date(p.publishDate).toISOString(),
                content: p.content,
                integrationId: p.integration?.id,
                integrationName: p.integration?.name,
                platform: p.integration?.providerIdentifier,
                hasAttachments: attachmentCount > 0,
                attachmentCount,
              };
            }),
        };
      },
    });
  }
}
