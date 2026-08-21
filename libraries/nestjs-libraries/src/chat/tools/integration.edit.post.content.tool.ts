import { AgentToolInterface } from '@gitroom/nestjs-libraries/chat/agent.tool.interface';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { Injectable } from '@nestjs/common';
import { socialIntegrationList } from '@gitroom/nestjs-libraries/integrations/integration.manager';
import { IntegrationService } from '@gitroom/nestjs-libraries/database/prisma/integrations/integration.service';
import { PostsService } from '@gitroom/nestjs-libraries/database/prisma/posts/posts.service';
import { makeId } from '@gitroom/nestjs-libraries/services/make.is';
import { checkAuth } from '@gitroom/nestjs-libraries/chat/auth.context';
import { stripHtmlValidation } from '@gitroom/helpers/utils/strip.html.validation';
import { weightedLength } from '@gitroom/helpers/utils/count.length';

function countCharacters(text: string, type: string): number {
  if (type !== 'x') {
    return text.length;
  }
  return weightedLength(text);
}

@Injectable()
export class IntegrationEditPostContentTool implements AgentToolInterface {
  constructor(
    private _postsService: PostsService,
    private _integrationService: IntegrationService
  ) {}
  name = 'integrationEditPostContentTool';

  run() {
    return createTool({
      id: 'integrationEditPostContentTool',
      description: `Edits the text/images of one part of an existing draft or scheduled post (for a thread, "part" means one tweet/entry in the chain — 0 is the first/main one). Cannot edit a post that has already been published. Always call integrationListPostsTool first to find the postId, and show the user the current content of that part before changing it, to confirm exactly what they want edited.`,
      inputSchema: z.object({
        postId: z
          .string()
          .describe(
            'The root post id to edit, from integrationListPostsTool'
          ),
        partIndex: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe(
            'Which part of the post/thread to edit — 0 is the first/main post. Defaults to 0. If unsure how many parts exist, ask the user or check with the user first.'
          ),
        content: z
          .string()
          .describe(
            'The new content for that part, HTML, each line wrapped in <p> (allowed tags: h1, h2, h3, u, strong, li, ul, p — not u and strong together)'
          ),
        attachments: z
          .array(z.string())
          .optional()
          .describe(
            "New image URLs to replace that part's images. Omit to keep the existing images unchanged."
          ),
        date: z
          .string()
          .optional()
          .describe(
            'New publish date/time in UTC. Omit to keep the post at its current scheduled time.'
          ),
      }),
      outputSchema: z.object({
        output: z
          .object({
            success: z.boolean(),
            postId: z.string().optional(),
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

        const root = existing.posts[0];
        if (root.state === 'PUBLISHED') {
          return {
            output: {
              errors:
                'This post has already been published and its content can no longer be edited.',
            },
          };
        }

        const partIndex = context.partIndex ?? 0;
        if (partIndex >= existing.posts.length) {
          return {
            output: {
              errors: `Post only has ${existing.posts.length} part(s), there is no part ${partIndex}.`,
            },
          };
        }

        const integration = await this._integrationService.getIntegrationById(
          organizationId,
          existing.integration
        );
        if (!integration) {
          return { output: { errors: 'Integration not found' } };
        }

        const providerInfo = socialIntegrationList.find(
          (p) => p.identifier === integration.providerIdentifier
        );

        if (providerInfo) {
          let isPremium = false;
          try {
            const storedSettings = JSON.parse(
              integration.additionalSettings || '[]'
            );
            const verifiedSetting = storedSettings.find(
              (s: { title?: string; value?: boolean }) =>
                s?.title === 'Verified'
            );
            isPremium = !!verifiedSetting?.value;
          } catch (err) {
            /** default to non-premium **/
          }

          const maximumCharacters = providerInfo.maxLength(isPremium);
          const strip = stripHtmlValidation('normal', context.content, true);
          const weighted = countCharacters(strip, providerInfo.identifier || '');
          const totalCharacters = weighted > strip.length ? weighted : strip.length;

          if (totalCharacters > (maximumCharacters || 1000000)) {
            return {
              output: {
                errors: `The maximum characters is ${maximumCharacters}, we got ${totalCharacters}, please shorten the content and try again.`,
              },
            };
          }
        }

        const value = existing.posts.map((post, index) => ({
          id: makeId(10),
          content: index === partIndex ? context.content : post.content,
          image:
            index === partIndex && context.attachments
              ? context.attachments.map((path) => ({ id: makeId(10), path }))
              : (post.image as any[]) || [],
        }));

        const result = await this._postsService.createPost(organizationId, {
          type: root.state === 'DRAFT' ? 'draft' : 'schedule',
          shortLink: false,
          date: context.date || new Date(root.publishDate).toISOString(),
          tags: [],
          posts: [
            {
              integration: { id: existing.integration },
              group: existing.group,
              settings: existing.settings,
              value,
            } as any,
          ],
        } as any);

        return {
          output: result?.[0]?.postId
            ? { success: true, postId: result[0].postId }
            : { success: false },
        };
      },
    });
  }
}
