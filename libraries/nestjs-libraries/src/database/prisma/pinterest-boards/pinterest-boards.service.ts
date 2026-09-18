import { Injectable } from '@nestjs/common';
import dayjs from 'dayjs';
import * as Sentry from '@sentry/nestjs';
import { Integration } from '@prisma/client';
import { IntegrationService } from '@gitroom/nestjs-libraries/database/prisma/integrations/integration.service';
import { IntegrationManager } from '@gitroom/nestjs-libraries/integrations/integration.manager';

export interface PinterestBoardResult {
  name: string;
  boardId?: string;
  error?: string;
}

@Injectable()
export class PinterestBoardsService {
  constructor(
    private _integrationService: IntegrationService,
    private _integrationManager: IntegrationManager
  ) {}

  async createBoards(
    organizationId: string,
    integrationId: string,
    boards: { name: string; description?: string; isPrivate?: boolean }[]
  ): Promise<PinterestBoardResult[]> {
    const integration = await this._integrationService.getIntegrationById(
      organizationId,
      integrationId
    );
    if (
      !integration ||
      integration.providerIdentifier !== 'pinterest' ||
      integration.deletedAt
    ) {
      throw new Error(
        'Integration not found, not a Pinterest account, or no longer connected'
      );
    }

    const accessToken = await this.getValidAccessToken(integration);
    const provider = this._integrationManager.getSocialIntegration('pinterest');

    // Sequential on purpose: createBoard() goes through the provider's
    // shared this.fetch() queue (see pinterest.provider.ts), which already
    // rate-limits and serializes every Pinterest call this app makes —
    // including pin deletion. Looping sequentially here just means we wait
    // for our own turn in that queue instead of piling up requests ahead of
    // ourselves; it doesn't add a second layer of throttling.
    const results: PinterestBoardResult[] = [];
    for (const board of boards) {
      try {
        const created = await provider.createBoard?.(
          integration.internalId,
          accessToken,
          board
        );
        if (!created?.id) {
          results.push({
            name: board.name,
            error: 'Pinterest did not return a board id',
          });
          continue;
        }
        results.push({ name: board.name, boardId: created.id });
      } catch (err) {
        results.push({
          name: board.name,
          error: err instanceof Error ? err.message : 'Unknown error',
        });
        Sentry.captureException(err, {
          extra: { context: 'PinterestBoardsService.createBoards', integrationId },
        });
      }
    }

    return results;
  }

  private async getValidAccessToken(integration: Integration): Promise<string> {
    const provider = this._integrationManager.getSocialIntegration('pinterest');

    if (dayjs(integration.tokenExpiration).isAfter(dayjs())) {
      return integration.token;
    }

    const { accessToken, expiresIn, refreshToken, additionalSettings } =
      await provider.refreshToken(integration.refreshToken!);

    if (!accessToken) {
      await this._integrationService.refreshNeeded(
        integration.organizationId,
        integration.id
      );
      throw new Error('Pinterest token refresh failed');
    }

    await this._integrationService.createOrUpdateIntegration(
      additionalSettings,
      !!provider.oneTimeToken,
      integration.organizationId,
      integration.name,
      integration.picture!,
      'social',
      integration.internalId,
      integration.providerIdentifier,
      accessToken,
      refreshToken,
      expiresIn
    );

    return accessToken;
  }
}
