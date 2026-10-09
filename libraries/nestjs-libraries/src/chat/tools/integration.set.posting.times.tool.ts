import { AgentToolInterface } from '@gitroom/nestjs-libraries/chat/agent.tool.interface';
import { createTool } from '@mastra/core/tools';
import { Injectable } from '@nestjs/common';
import { IntegrationService } from '@gitroom/nestjs-libraries/database/prisma/integrations/integration.service';
import z from 'zod';
import { checkAuth } from '@gitroom/nestjs-libraries/chat/auth.context';
import {
  labelsToPostingTimes,
  toPostingTimeView,
} from '@gitroom/nestjs-libraries/chat/posting.times';

@Injectable()
export class IntegrationSetPostingTimesTool implements AgentToolInterface {
  constructor(private _integrationService: IntegrationService) {}
  name = 'integrationSetPostingTimesTool';

  run() {
    return createTool({
      id: 'integrationSetPostingTimesTool',
      description: `Replaces the preset posting time slots of one channel (integration) with the given list, exactly like the "Add Time Slot" dialog in the web app. Times are in the user's local time as HH:mm (24h). This REPLACES the whole list, so call integrationList first and include every slot that should be kept. Always confirm the final list with the user before calling this. Pass an empty list to remove all slots.`,
      inputSchema: z.object({
        integrationId: z
          .string()
          .describe('The id of the channel, from integrationList'),
        times: z
          .array(z.string())
          .describe(
            'The complete list of slots in local time, HH:mm 24h, e.g. ["09:20", "14:10", "19:00"]'
          ),
      }),
      outputSchema: z.object({
        output: z
          .object({
            success: z.boolean(),
            postingTimes: z.array(
              z.object({ time: z.number(), label: z.string() })
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

        const integration = await this._integrationService.getIntegrationById(
          organizationId,
          context.integrationId
        );
        if (!integration) {
          return { output: { errors: 'Integration not found' } };
        }

        const parsed = labelsToPostingTimes(context.times);
        if ('invalid' in parsed) {
          return {
            output: {
              errors: `These are not valid HH:mm (24h) times: ${parsed.invalid.join(
                ', '
              )}. Fix them and run integrationSetPostingTimesTool again.`,
            },
          };
        }

        await this._integrationService.setTimes(
          organizationId,
          context.integrationId,
          { time: parsed.times }
        );

        return {
          output: {
            success: true,
            postingTimes: toPostingTimeView(JSON.stringify(parsed.times)),
          },
        };
      },
    });
  }
}
