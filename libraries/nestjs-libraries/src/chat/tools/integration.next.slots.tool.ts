import { AgentToolInterface } from '@gitroom/nestjs-libraries/chat/agent.tool.interface';
import { createTool } from '@mastra/core/tools';
import { Injectable } from '@nestjs/common';
import { PostsService } from '@gitroom/nestjs-libraries/database/prisma/posts/posts.service';
import z from 'zod';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import { checkAuth } from '@gitroom/nestjs-libraries/chat/auth.context';
import { minutesToLabel } from '@gitroom/nestjs-libraries/chat/posting.times';

dayjs.extend(utc);

@Injectable()
export class IntegrationNextSlotsTool implements AgentToolInterface {
  constructor(private _postsService: PostsService) {}
  name = 'integrationNextSlotsTool';

  run() {
    return createTool({
      id: 'integrationNextSlotsTool',
      description: `Returns the next free preset posting time slots of one channel (integration), as UTC dates ready to pass as "date" to integrationSchedulePostTool. Slots already taken by a queued or published post are skipped. Use this when the user wants a post scheduled "in the next slot" or spread across the channel's preset slots. Show the user the localLabel times, not the UTC dates.`,
      inputSchema: z.object({
        integrationId: z
          .string()
          .describe('The id of the channel, from integrationList'),
        count: z
          .number()
          .int()
          .min(1)
          .max(50)
          .describe('How many upcoming free slots to return'),
      }),
      outputSchema: z.object({
        output: z
          .object({
            timezoneOffsetMinutes: z
              .number()
              .describe(
                "The user's UTC offset in minutes used to convert slots (e.g. 480 for Singapore)"
              ),
            slots: z.array(
              z.object({
                date: z.string().describe('UTC ISO date of the slot'),
                localLabel: z
                  .string()
                  .describe('The same instant as HH:mm in the user local time'),
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

        const result = await this._postsService.getNextPresetSlots(
          organizationId,
          context.integrationId,
          context.count
        );

        if (!result) {
          return { output: { errors: 'Integration not found' } };
        }

        if (!result.postingTimes.length) {
          return {
            output: {
              errors:
                'This channel has no preset time slots. Add some with integrationSetPostingTimesTool first.',
            },
          };
        }

        return {
          output: {
            timezoneOffsetMinutes: result.timezoneOffset,
            slots: result.slots.map((slot) => {
              const utcDate = dayjs.utc(slot);
              return {
                date: utcDate.toISOString(),
                localLabel: minutesToLabel(
                  utcDate.hour() * 60 + utcDate.minute() + result.timezoneOffset
                ),
              };
            }),
          },
        };
      },
    });
  }
}
