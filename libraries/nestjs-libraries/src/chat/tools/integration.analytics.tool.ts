import { AgentToolInterface } from '@gitroom/nestjs-libraries/chat/agent.tool.interface';
import { createTool } from '@mastra/core/tools';
import { Injectable } from '@nestjs/common';
import { IntegrationService } from '@gitroom/nestjs-libraries/database/prisma/integrations/integration.service';
import { Organization } from '@prisma/client';
import z from 'zod';
import { checkAuth } from '@gitroom/nestjs-libraries/chat/auth.context';

@Injectable()
export class IntegrationAnalyticsTool implements AgentToolInterface {
  constructor(private _integrationService: IntegrationService) {}
  name = 'integrationAnalyticsTool';

  run() {
    return createTool({
      id: 'integrationAnalyticsTool',
      description: `Reads performance/analytics data for one integration (channel) — followers, engagement, etc, depending on what the platform exposes. Use integrationList first to get the integration id.`,
      inputSchema: z.object({
        integrationId: z
          .string()
          .describe('The id of the integration, from integrationList'),
        startDate: z
          .string()
          .optional()
          .describe('Start of the date range, ISO date'),
        endDate: z
          .string()
          .optional()
          .describe('End of the date range, ISO date'),
      }),
      outputSchema: z.object({
        output: z.array(z.any()),
      }),
      execute: async (args, options) => {
        const { context, runtimeContext } = args;
        checkAuth(args, options);
        const organizationId = JSON.parse(
          // @ts-ignore
          runtimeContext.get('organization') as string
        ).id;

        const data = await this._integrationService.checkAnalytics(
          { id: organizationId } as Organization,
          context.integrationId,
          context.endDate || new Date().toISOString(),
          false,
          context.startDate,
          context.endDate
        );

        return { output: data || [] };
      },
    });
  }
}
