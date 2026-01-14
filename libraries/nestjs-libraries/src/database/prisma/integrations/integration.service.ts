import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { IntegrationRepository } from '@gitroom/nestjs-libraries/database/prisma/integrations/integration.repository';
import { IntegrationManager } from '@gitroom/nestjs-libraries/integrations/integration.manager';
import { InstagramProvider } from '@gitroom/nestjs-libraries/integrations/social/instagram.provider';
import { FacebookProvider } from '@gitroom/nestjs-libraries/integrations/social/facebook.provider';
import {
  AnalyticsData,
  AuthTokenDetails,
  SocialProvider,
} from '@gitroom/nestjs-libraries/integrations/social/social.integrations.interface';
import { Integration, Organization } from '@prisma/client';
import { NotificationService } from '@gitroom/nestjs-libraries/database/prisma/notifications/notification.service';
import { LinkedinPageProvider } from '@gitroom/nestjs-libraries/integrations/social/linkedin.page.provider';
import dayjs from 'dayjs';
import { timer } from '@gitroom/helpers/utils/timer';
import { ioRedis } from '@gitroom/nestjs-libraries/redis/redis.service';
import { RefreshToken } from '@gitroom/nestjs-libraries/integrations/social.abstract';
import { IntegrationTimeDto } from '@gitroom/nestjs-libraries/dtos/integrations/integration.time.dto';
import { UploadFactory } from '@gitroom/nestjs-libraries/upload/upload.factory';
import { PlugDto } from '@gitroom/nestjs-libraries/dtos/plugs/plug.dto';
import { BullMqClient } from '@gitroom/nestjs-libraries/bull-mq-transport-new/client';
import { difference, uniq } from 'lodash';
import utc from 'dayjs/plugin/utc';
import { AutopostRepository } from '@gitroom/nestjs-libraries/database/prisma/autopost/autopost.repository';
import { PostsRepository } from '@gitroom/nestjs-libraries/database/prisma/posts/posts.repository';
import * as Sentry from '@sentry/nestjs';

dayjs.extend(utc);

@Injectable()
export class IntegrationService {
  private storage = UploadFactory.createStorage();
  constructor(
    private _integrationRepository: IntegrationRepository,
    private _autopostsRepository: AutopostRepository,
    private _postsRepository: PostsRepository,
    private _integrationManager: IntegrationManager,
    private _notificationService: NotificationService,
    private _workerServiceProducer: BullMqClient
  ) {}

  async changeActiveCron(orgId: string) {
    const data = await this._autopostsRepository.getAutoposts(orgId);

    for (const item of data.filter((f) => f.active)) {
      await this._workerServiceProducer.deleteScheduler('cron', item.id);
    }

    return true;
  }

  getMentions(platform: string, q: string) {
    return this._integrationRepository.getMentions(platform, q);
  }

  insertMentions(
    platform: string,
    mentions: { name: string; username: string; image: string }[]
  ) {
    return this._integrationRepository.insertMentions(platform, mentions);
  }

  async setTimes(
    orgId: string,
    integrationId: string,
    times: IntegrationTimeDto
  ) {
    return this._integrationRepository.setTimes(orgId, integrationId, times);
  }

  updateProviderSettings(org: string, id: string, additionalSettings: string) {
    return this._integrationRepository.updateProviderSettings(
      org,
      id,
      additionalSettings
    );
  }

  checkPreviousConnections(org: string, id: string) {
    return this._integrationRepository.checkPreviousConnections(org, id);
  }

  async createOrUpdateIntegration(
    additionalSettings:
      | {
          title: string;
          description: string;
          type: 'checkbox' | 'text' | 'textarea';
          value: any;
          regex?: string;
        }[]
      | undefined,
    oneTimeToken: boolean,
    org: string,
    name: string,
    picture: string | undefined,
    type: 'article' | 'social',
    internalId: string,
    provider: string,
    token: string,
    refreshToken = '',
    expiresIn?: number,
    username?: string,
    isBetweenSteps = false,
    refresh?: string,
    timezone?: number,
    customInstanceDetails?: string
  ) {
    const uploadedPicture = picture
      ? picture?.indexOf('imagedelivery.net') > -1
        ? picture
        : await this.storage.uploadSimple(picture)
      : undefined;

    const result = await this._integrationRepository.createOrUpdateIntegration(
      additionalSettings,
      oneTimeToken,
      org,
      name,
      uploadedPicture,
      type,
      internalId,
      provider,
      token,
      refreshToken,
      expiresIn,
      username,
      isBetweenSteps,
      refresh,
      timezone,
      customInstanceDetails
    );

    // If this is a reconnection (update with refresh), reschedule missed posts
    if (refresh && type === 'social') {
      // Use setImmediate to avoid blocking the reconnection response
      setImmediate(async () => {
        try {
          await this.rescheduleMissedPostsForIntegration(result.id, result);
        } catch (err) {
          Sentry.captureException(err, {
            extra: {
              context: 'Failed to reschedule missed posts after reconnection',
              integrationId: result.id,
            },
          });
        }
      });
    }

    return result;
  }

  updateIntegrationGroup(org: string, id: string, group: string) {
    return this._integrationRepository.updateIntegrationGroup(org, id, group);
  }

  updateOnCustomerName(org: string, id: string, name: string) {
    return this._integrationRepository.updateOnCustomerName(org, id, name);
  }

  getIntegrationsList(org: string) {
    return this._integrationRepository.getIntegrationsList(org);
  }

  getAllActiveIntegrations() {
    return this._integrationRepository.getAllActiveIntegrations();
  }

  getIntegrationForOrder(id: string, order: string, user: string, org: string) {
    return this._integrationRepository.getIntegrationForOrder(
      id,
      order,
      user,
      org
    );
  }

  updateNameAndUrl(id: string, name: string, url: string) {
    return this._integrationRepository.updateNameAndUrl(id, name, url);
  }

  getIntegrationById(org: string, id: string) {
    return this._integrationRepository.getIntegrationById(org, id);
  }

  getIntegrationByIdOnly(id: string) {
    return this._integrationRepository.getIntegrationByIdOnly(id);
  }

  async getUserTimezone(integrationId: string): Promise<number> {
    const integration = await this._integrationRepository.getIntegrationByIdOnly(integrationId);
    return integration?.organization?.users?.[0]?.user?.timezone || 0;
  }

  async refreshToken(provider: SocialProvider, refresh: string) {
    try {
      const { refreshToken, accessToken, expiresIn } =
        await provider.refreshToken(refresh);

      if (!refreshToken || !accessToken || !expiresIn) {
        return false;
      }

      return { refreshToken, accessToken, expiresIn };
    } catch (e) {
      return false;
    }
  }

  async disconnectChannel(orgId: string, integration: Integration) {
    await this._integrationRepository.disconnectChannel(orgId, integration.id);
    await this.informAboutRefreshError(orgId, integration);
  }

  async informAboutRefreshError(
    orgId: string,
    integration: Integration,
    err = ''
  ) {
    await this._notificationService.inAppNotification(
      orgId,
      `Could not refresh your ${integration.providerIdentifier} channel ${err}`,
      `Could not refresh your ${integration.providerIdentifier} channel ${err}. Please go back to the system and connect it again ${process.env.FRONTEND_URL}/launches`,
      true
    );
  }

  async refreshNeeded(org: string, id: string) {
    return this._integrationRepository.refreshNeeded(org, id);
  }

  async refreshTokens() {
    const integrations = await this._integrationRepository.needsToBeRefreshed();
    for (const integration of integrations) {
      const provider = this._integrationManager.getSocialIntegration(
        integration.providerIdentifier
      );

      const data = await this.refreshToken(provider, integration.refreshToken!);

      if (!data) {
        await this.informAboutRefreshError(
          integration.organizationId,
          integration
        );
        await this._integrationRepository.refreshNeeded(
          integration.organizationId,
          integration.id
        );
        return;
      }

      const { refreshToken, accessToken, expiresIn } = data;

      await this.createOrUpdateIntegration(
        undefined,
        !!provider.oneTimeToken,
        integration.organizationId,
        integration.name,
        undefined,
        'social',
        integration.internalId,
        integration.providerIdentifier,
        accessToken,
        refreshToken,
        expiresIn
      );
    }
  }

  async disableChannel(org: string, id: string) {
    return this._integrationRepository.disableChannel(org, id);
  }

  async enableChannel(org: string, totalChannels: number, id: string) {
    const integrations = (
      await this._integrationRepository.getIntegrationsList(org)
    ).filter((f) => !f.disabled);
    if (
      !!process.env.STRIPE_PUBLISHABLE_KEY &&
      integrations.length >= totalChannels
    ) {
      throw new Error('You have reached the maximum number of channels');
    }

    return this._integrationRepository.enableChannel(org, id);
  }

  async getPostsForChannel(org: string, id: string) {
    return this._integrationRepository.getPostsForChannel(org, id);
  }

  async deleteChannel(org: string, id: string) {
    return this._integrationRepository.deleteChannel(org, id);
  }

  async disableIntegrations(org: string, totalChannels: number) {
    return this._integrationRepository.disableIntegrations(org, totalChannels);
  }

  async checkForDeletedOnceAndUpdate(org: string, page: string) {
    return this._integrationRepository.checkForDeletedOnceAndUpdate(org, page);
  }

  async saveInstagram(
    org: string,
    id: string,
    data: { pageId: string; id: string }
  ) {
    const getIntegration = await this._integrationRepository.getIntegrationById(
      org,
      id
    );
    if (getIntegration && !getIntegration.inBetweenSteps) {
      throw new HttpException('Invalid request', HttpStatus.BAD_REQUEST);
    }

    const instagram = this._integrationManager.getSocialIntegration(
      'instagram'
    ) as InstagramProvider;
    const getIntegrationInformation = await instagram.fetchPageInformation(
      getIntegration?.token!,
      data
    );

    await this.checkForDeletedOnceAndUpdate(org, getIntegrationInformation.id);
    await this._integrationRepository.updateIntegration(id, {
      picture: getIntegrationInformation.picture,
      internalId: getIntegrationInformation.id,
      name: getIntegrationInformation.name,
      inBetweenSteps: false,
      token: getIntegrationInformation.access_token,
      profile: getIntegrationInformation.username,
    });

    return { success: true };
  }

  async saveLinkedin(org: string, id: string, page: string) {
    const getIntegration = await this._integrationRepository.getIntegrationById(
      org,
      id
    );
    if (getIntegration && !getIntegration.inBetweenSteps) {
      throw new HttpException('Invalid request', HttpStatus.BAD_REQUEST);
    }

    const linkedin = this._integrationManager.getSocialIntegration(
      'linkedin-page'
    ) as LinkedinPageProvider;

    const getIntegrationInformation = await linkedin.fetchPageInformation(
      getIntegration?.token!,
      page
    );

    await this.checkForDeletedOnceAndUpdate(
      org,
      String(getIntegrationInformation.id)
    );

    await this._integrationRepository.updateIntegration(String(id), {
      picture: getIntegrationInformation.picture,
      internalId: String(getIntegrationInformation.id),
      name: getIntegrationInformation.name,
      inBetweenSteps: false,
      token: getIntegrationInformation.access_token,
      profile: getIntegrationInformation.username,
    });

    return { success: true };
  }

  async saveFacebook(org: string, id: string, page: string) {
    const getIntegration = await this._integrationRepository.getIntegrationById(
      org,
      id
    );
    if (getIntegration && !getIntegration.inBetweenSteps) {
      throw new HttpException('Invalid request', HttpStatus.BAD_REQUEST);
    }

    const facebook = this._integrationManager.getSocialIntegration(
      'facebook'
    ) as FacebookProvider;
    const getIntegrationInformation = await facebook.fetchPageInformation(
      getIntegration?.token!,
      page
    );

    await this.checkForDeletedOnceAndUpdate(org, getIntegrationInformation.id);
    await this._integrationRepository.updateIntegration(id, {
      picture: getIntegrationInformation.picture,
      internalId: getIntegrationInformation.id,
      name: getIntegrationInformation.name,
      inBetweenSteps: false,
      token: getIntegrationInformation.access_token,
      profile: getIntegrationInformation.username,
    });

    return { success: true };
  }

  async checkAnalytics(
    org: Organization,
    integration: string,
    date: string,
    forceRefresh = false
  ): Promise<AnalyticsData[]> {
    const getIntegration = await this.getIntegrationById(org.id, integration);

    if (!getIntegration) {
      throw new Error('Invalid integration');
    }

    if (getIntegration.type !== 'social') {
      return [];
    }

    const integrationProvider = this._integrationManager.getSocialIntegration(
      getIntegration.providerIdentifier
    );

    if (
      dayjs(getIntegration?.tokenExpiration).isBefore(dayjs()) ||
      forceRefresh
    ) {
      const { accessToken, expiresIn, refreshToken, additionalSettings } =
        await new Promise<AuthTokenDetails>((res) => {
          return integrationProvider
            .refreshToken(getIntegration.refreshToken!)
            .then((r) => res(r))
            .catch(() => {
              res({
                error: '',
                accessToken: '',
                id: '',
                name: '',
                picture: '',
                username: '',
                additionalSettings: undefined,
              });
            });
        });

      if (accessToken) {
        await this.createOrUpdateIntegration(
          additionalSettings,
          !!integrationProvider.oneTimeToken,
          getIntegration.organizationId,
          getIntegration.name,
          getIntegration.picture!,
          'social',
          getIntegration.internalId,
          getIntegration.providerIdentifier,
          accessToken,
          refreshToken,
          expiresIn
        );

        getIntegration.token = accessToken;

        if (integrationProvider.refreshWait) {
          await timer(10000);
        }
      } else {
        await this.disconnectChannel(org.id, getIntegration);
        return [];
      }
    }

    const getIntegrationData = await ioRedis.get(
      `integration:${org.id}:${integration}:${date}`
    );
    if (getIntegrationData) {
      return JSON.parse(getIntegrationData);
    }

    if (integrationProvider.analytics) {
      try {
        const loadAnalytics = await integrationProvider.analytics(
          getIntegration.internalId,
          getIntegration.token,
          +date
        );
        await ioRedis.set(
          `integration:${org.id}:${integration}:${date}`,
          JSON.stringify(loadAnalytics),
          'EX',
          !process.env.NODE_ENV || process.env.NODE_ENV === 'development'
            ? 1
            : 3600
        );
        return loadAnalytics;
      } catch (e) {
        if (e instanceof RefreshToken) {
          return this.checkAnalytics(org, integration, date, true);
        }
      }
    }

    return [];
  }

  customers(orgId: string) {
    return this._integrationRepository.customers(orgId);
  }

  getPlugsByIntegrationId(org: string, integrationId: string) {
    return this._integrationRepository.getPlugsByIntegrationId(
      org,
      integrationId
    );
  }

  async processInternalPlug(
    data: {
      post: string;
      originalIntegration: string;
      integration: string;
      plugName: string;
      orgId: string;
      delay: number;
      information: any;
    },
    forceRefresh = false
  ): Promise<any> {
    const originalIntegration =
      await this._integrationRepository.getIntegrationById(
        data.orgId,
        data.originalIntegration
      );

    const getIntegration = await this._integrationRepository.getIntegrationById(
      data.orgId,
      data.integration
    );

    if (!getIntegration || !originalIntegration) {
      return;
    }

    const getAllInternalPlugs = this._integrationManager
      .getInternalPlugs(getIntegration.providerIdentifier)
      .internalPlugs.find((p: any) => p.identifier === data.plugName);

    if (!getAllInternalPlugs) {
      return;
    }

    const getSocialIntegration = this._integrationManager.getSocialIntegration(
      getIntegration.providerIdentifier
    );

    if (
      dayjs(getIntegration?.tokenExpiration).isBefore(dayjs()) ||
      forceRefresh
    ) {
      const { accessToken, expiresIn, refreshToken, additionalSettings } =
        await new Promise<AuthTokenDetails>((res) => {
          getSocialIntegration
            .refreshToken(getIntegration.refreshToken!)
            .then((r) => res(r))
            .catch(() =>
              res({
                accessToken: '',
                expiresIn: 0,
                refreshToken: '',
                id: '',
                name: '',
                username: '',
                picture: '',
                additionalSettings: undefined,
              })
            );
        });

      if (!accessToken) {
        await this.refreshNeeded(
          getIntegration.organizationId,
          getIntegration.id
        );

        await this.informAboutRefreshError(
          getIntegration.organizationId,
          getIntegration
        );
        return {};
      }

      await this.createOrUpdateIntegration(
        additionalSettings,
        !!getSocialIntegration.oneTimeToken,
        getIntegration.organizationId,
        getIntegration.name,
        getIntegration.picture!,
        'social',
        getIntegration.internalId,
        getIntegration.providerIdentifier,
        accessToken,
        refreshToken,
        expiresIn
      );

      getIntegration.token = accessToken;

      if (getSocialIntegration.refreshWait) {
        await timer(10000);
      }
    }

    try {
      // @ts-ignore
      await getSocialIntegration?.[getAllInternalPlugs.methodName]?.(
        getIntegration,
        originalIntegration,
        data.post,
        data.information
      );
    } catch (err) {
      if (err instanceof RefreshToken) {
        return this.processInternalPlug(data, true);
      }

      return;
    }
  }

  async processPlugs(data: {
    plugId: string;
    postId: string;
    delay: number;
    totalRuns: number;
    currentRun: number;
  }) {
    const getPlugById = await this._integrationRepository.getPlug(data.plugId);
    if (!getPlugById) {
      return;
    }

    const integration = this._integrationManager.getSocialIntegration(
      getPlugById.integration.providerIdentifier
    );

    const findPlug = this._integrationManager
      .getAllPlugs()
      .find(
        (p) => p.identifier === getPlugById.integration.providerIdentifier
      )!;

    // @ts-ignore
    const process = await integration[getPlugById.plugFunction](
      getPlugById.integration,
      data.postId,
      JSON.parse(getPlugById.data).reduce((all: any, current: any) => {
        all[current.name] = current.value;
        return all;
      }, {})
    );

    if (process) {
      return;
    }

    if (data.totalRuns === data.currentRun) {
      return;
    }

    this._workerServiceProducer.emit('plugs', {
      id: 'plug_' + data.postId + '_' + findPlug.identifier,
      options: {
        delay: data.delay,
      },
      payload: {
        plugId: data.plugId,
        postId: data.postId,
        delay: data.delay,
        totalRuns: data.totalRuns,
        currentRun: data.currentRun + 1,
      },
    });
  }

  async createOrUpdatePlug(
    orgId: string,
    integrationId: string,
    body: PlugDto
  ) {
    const { activated } = await this._integrationRepository.createOrUpdatePlug(
      orgId,
      integrationId,
      body
    );

    return {
      activated,
    };
  }

  async changePlugActivation(orgId: string, plugId: string, status: boolean) {
    const { id, integrationId, plugFunction } =
      await this._integrationRepository.changePlugActivation(
        orgId,
        plugId,
        status
      );

    return { id };
  }

  async getPlugs(orgId: string, integrationId: string) {
    return this._integrationRepository.getPlugs(orgId, integrationId);
  }

  async loadExisingData(
    methodName: string,
    integrationId: string,
    id: string[]
  ) {
    const exisingData = await this._integrationRepository.loadExisingData(
      methodName,
      integrationId,
      id
    );
    const loadOnlyIds = exisingData.map((p) => p.value);
    return difference(id, loadOnlyIds);
  }

  async findFreeDateTime(
    orgId: string,
    integrationsId?: string
  ): Promise<number[]> {
    const findTimes = await this._integrationRepository.getPostingTimes(
      orgId,
      integrationsId
    );
    return uniq(
      findTimes.reduce((all: any, current: any) => {
        return [
          ...all,
          ...JSON.parse(current.postingTimes).map(
            (p: { time: number }) => p.time
          ),
        ];
      }, [] as number[])
    );
  }

  async rescheduleMissedPostsForIntegration(
    integrationId: string,
    integration: Integration
  ) {
    const { logger } = Sentry;
    try {
      // Get user timezone from integration's organization
      const integrationWithOrg = await this._integrationRepository.getIntegrationByIdOnly(
        integrationId
      );
      const userTimezone = integrationWithOrg?.organization?.users?.[0]?.user?.timezone || 0;
      
      // Get all missed posts for this integration
      const missedPosts = await this._postsRepository.getMissedPostsForIntegration(
        integrationId
      );

      if (missedPosts.length === 0) {
        logger.info(
          logger.fmt`No missed posts to reschedule for integration ${integrationId}`
        );
        return { rescheduled: 0 };
      }

      // Get posting times for this integration
      const postingTimes = JSON.parse(integration.postingTimes || '[]');

      if (postingTimes.length === 0) {
        logger.warn(
          logger.fmt`No posting times configured for integration ${integrationId}, cannot reschedule posts`
        );
        return { rescheduled: 0 };
      }

      // Reschedule posts to available slots one at a time
      let rescheduledCount = 0;
      const usedSlots = new Set<number>(); // Track slots we've assigned in this session
      
      for (const post of missedPosts) {
        // Get next available slot that hasn't been used yet in this batch
        // Search from end: move missed posts to the end of schedule instead of next available hour
        const availableSlot = await this._postsRepository.getNextAvailableSlots(
          post.organizationId,
          integrationId,
          1, // Get one slot at a time
          postingTimes,
          true, // searchFromEnd: move to end of schedule
          userTimezone // Pass user's timezone for proper UTC conversion
        );

        if (availableSlot.length === 0) {
          logger.warn(
            `No available slot found for post ${post.id}, stopping reschedule`
          );
          break;
        }

        const newSlot = availableSlot[0];
        const slotTimestamp = dayjs(newSlot).valueOf();

        // Double-check this slot hasn't been used in this session
        if (usedSlots.has(slotTimestamp)) {
          logger.warn(
            `Slot ${newSlot} already used in this session, skipping post ${post.id}`
          );
          continue;
        }

        // Update the post's publish date
        await this._postsRepository.updatePostPublishDate(post.id, newSlot);
        usedSlots.add(slotTimestamp);

        // Re-queue the post in the worker
        this._workerServiceProducer.emit('post', {
          id: post.id,
          options: {
            delay: dayjs(newSlot).diff(dayjs(), 'millisecond'),
          },
          payload: {
            id: post.id,
          },
        });

        rescheduledCount++;
        logger.info(
          `Rescheduled post ${post.id} from ${dayjs(post.publishDate).format('YYYY-MM-DD HH:mm')} to ${dayjs(newSlot).format('YYYY-MM-DD HH:mm')}`
        );
      }

      // Send notification to user
      if (rescheduledCount > 0) {
        await this._notificationService.inAppNotification(
          missedPosts[0].organizationId,
          `${rescheduledCount} missed ${rescheduledCount === 1 ? 'post has' : 'posts have'} been rescheduled`,
          `We've automatically rescheduled ${rescheduledCount} missed ${
            rescheduledCount === 1 ? 'post' : 'posts'
          } for ${integration.name} (${
            integration.providerIdentifier
          }) to the next available time ${
            rescheduledCount === 1 ? 'slot' : 'slots'
          }.`,
          true
        );
      }

      return { rescheduled: rescheduledCount };
    } catch (err) {
      Sentry.captureException(err, {
        extra: {
          context: 'Failed to reschedule missed posts',
          integrationId,
        },
      });
      logger.error(
        `Error rescheduling missed posts for integration ${integrationId}: ${err instanceof Error ? err.message : String(err)}`
      );
      return { rescheduled: 0 };
    }
  }

  async resolveDuplicatesForIntegration(integrationId: string, integration: any) {
    const { logger } = Sentry;
    let rescheduledCount = 0;

    try {
      // Get user timezone from integration's organization
      const integrationWithOrg = await this._integrationRepository.getIntegrationByIdOnly(
        integrationId
      );
      const userTimezone = integrationWithOrg?.organization?.users?.[0]?.user?.timezone || 0;
      
      // Get all posts with duplicate schedules (actual posts, not summaries)
      const allDuplicates = await this._postsRepository.findDuplicateSchedules();
      // ONLY reschedule QUEUE posts - NEVER ERROR or PUBLISHED
      const integrationDuplicates = allDuplicates.filter(p => 
        p.integrationId === integrationId && p.state === 'QUEUE'
      );

      if (integrationDuplicates.length === 0) {
        console.log(`No duplicate QUEUE posts found for integration ${integrationId}`);
        return { rescheduled: 0 };
      }

      console.log(`Found ${integrationDuplicates.length} QUEUE posts with duplicates for integration ${integrationId}`);

      // Parse posting times
      const postingTimes = JSON.parse(integration.postingTimes || '[]');
      console.log(`Integration has ${postingTimes.length} posting time slots configured`);

      if (postingTimes.length === 0) {
        console.log(`No posting times configured for integration ${integrationId}, cannot reschedule duplicates`);
        return { rescheduled: 0 };
      }

      // Group by timeslot
      const slotGroups = new Map<string, typeof integrationDuplicates>();
      for (const post of integrationDuplicates) {
        const slotKey = dayjs(post.publishDate).second(0).millisecond(0).format('YYYY-MM-DD HH:mm');
        if (!slotGroups.has(slotKey)) {
          slotGroups.set(slotKey, []);
        }
        slotGroups.get(slotKey)!.push(post);
      }

      console.log(`Grouped into ${slotGroups.size} duplicate timeslots`);

      // For each timeslot with duplicates, keep first (oldest), reschedule rest
      for (const [slotKey, postsInSlot] of slotGroups.entries()) {
        if (postsInSlot.length <= 1) continue;

        const queuePostsInSlot = postsInSlot.filter(p => p.state === 'QUEUE');
        console.log(`Timeslot ${slotKey}: ${postsInSlot.length} total posts (${queuePostsInSlot.length} QUEUE) - rescheduling ${Math.max(0, queuePostsInSlot.length - 1)} QUEUE posts`);

        // Already sorted by createdAt (oldest first), skip first, reschedule rest
        // ONLY reschedule QUEUE posts - filter out any ERROR or PUBLISHED posts
        const postsToReschedule = postsInSlot.slice(1).filter(p => p.state === 'QUEUE');

        for (const post of postsToReschedule) {
          try {
            // Double-check state before rescheduling (safety check)
            if (post.state !== 'QUEUE') {
              console.log(`⚠️ Skipping post ${post.id} - state is ${post.state}, not QUEUE`);
              continue;
            }
            
            const currentDate = dayjs(post.publishDate);
            const nextSlot = await this._postsRepository.getNextAvailableSlots(
              post.organizationId,
              integrationId,
              1,
              postingTimes,
              true, // Search from end: move duplicates to the end of schedule
              userTimezone // Pass user's timezone for proper UTC conversion
            );

            if (nextSlot.length > 0) {
              const nextSlotDate = dayjs(nextSlot[0]);
              await this._postsRepository.changeDate(
                post.organizationId,
                post.id,
                nextSlot[0].toISOString()
              );
              
              logger.info(`Rescheduled duplicate post ${post.id} from ${currentDate.format('YYYY-MM-DD HH:mm')} to ${nextSlotDate.format('YYYY-MM-DD HH:mm')}`);
              console.log(`✓ Rescheduled post ${post.id} from ${currentDate.format('YYYY-MM-DD HH:mm')} to ${nextSlotDate.format('YYYY-MM-DD HH:mm')}`);
              rescheduledCount++;
            } else {
              console.log(`No available slots found for post ${post.id}`);
            }
          } catch (err) {
            logger.error(`Failed to reschedule duplicate post ${post.id}: ${err instanceof Error ? err.message : String(err)}`);
            console.error(`Failed to reschedule post ${post.id}:`, err);
          }
        }
      }

      console.log(`Completed - rescheduled ${rescheduledCount} posts for integration ${integrationId}`);
      return { rescheduled: rescheduledCount };
    } catch (err) {
      Sentry.captureException(err, {
        extra: {
          context: 'Failed to resolve duplicates',
          integrationId,
        },
      });
      logger.error(`Error resolving duplicates for integration ${integrationId}: ${err instanceof Error ? err.message : String(err)}`);
      return { rescheduled: 0 };
    }
  }

  async checkAndRescheduleMissedPosts() {
    const { logger } = Sentry;
    logger.info('Checking for duplicate post schedules on startup...');
    
    try {
      // Check for duplicates
      const duplicates = await this._postsRepository.findDuplicateSchedules();
      
      if (duplicates.length === 0) {
        logger.info('No duplicate schedules found');
        console.log('No duplicate schedules found');
        return;
      }

      logger.info(`Found ${duplicates.length} duplicate schedules`);
      console.log(`Found ${duplicates.length} duplicate schedules`);

      // Group duplicates by integration
      const byIntegration = new Map<string, typeof duplicates>();
      for (const dup of duplicates) {
        if (!byIntegration.has(dup.integrationId)) {
          byIntegration.set(dup.integrationId, []);
        }
        byIntegration.get(dup.integrationId)!.push(dup);
      }

      // Process each integration's duplicates
      let totalRescheduled = 0;
      for (const [integrationId, dups] of byIntegration.entries()) {
        logger.info(`Processing ${dups.length} duplicate(s) for integration ${integrationId}`);
        console.log(`Processing ${dups.length} duplicate(s) for integration ${integrationId}`);
        
        try {
          const integration = await this._integrationRepository.getIntegrationByIdOnly(integrationId);
          if (integration) {
            const result = await this.resolveDuplicatesForIntegration(integrationId, integration);
            totalRescheduled += result.rescheduled;
          }
        } catch (err) {
          logger.error(`Error processing integration ${integrationId}: ${err instanceof Error ? err.message : String(err)}`);
          console.error(`Error processing integration ${integrationId}:`, err);
        }
      }

      logger.info(`Startup duplicate check completed - rescheduled ${totalRescheduled} posts`);
      console.log(`Startup duplicate check completed - rescheduled ${totalRescheduled} posts`);
    } catch (err) {
      Sentry.captureException(err, {
        extra: {
          context: 'Failed startup duplicate check',
        },
      });
      logger.error(`Error during startup duplicate check: ${err instanceof Error ? err.message : String(err)}`);
      console.error('Error during startup duplicate check:', err);
    }
  }

  async rescheduleInvalidTimeSlots(orgId?: string, integrationId?: string) {
    const { logger } = Sentry;
    console.log('[INVALID TIME SLOTS] Starting validation of scheduled post times...');
    logger.info('Starting validation of scheduled post times');

    try {
      // Find all posts at invalid time slots
      const invalidPosts = await this._postsRepository.findPostsAtInvalidTimeSlots(orgId, integrationId);

      if (invalidPosts.length === 0) {
        console.log('[INVALID TIME SLOTS] ✅ All posts are scheduled at valid time slots');
        logger.info('All posts are scheduled at valid time slots');
        return { rescheduled: 0, checked: 0 };
      }

      console.log(
        `[INVALID TIME SLOTS] ⚠️ Found ${invalidPosts.length} posts at invalid time slots`
      );
      logger.warn(`Found ${invalidPosts.length} posts at invalid time slots`);

      let totalRescheduled = 0;
      const usedSlots = new Set<number>();

      // Group by integration for efficient processing
      const byIntegration = new Map<string, typeof invalidPosts>();
      for (const post of invalidPosts) {
        if (!byIntegration.has(post.integrationId)) {
          byIntegration.set(post.integrationId, []);
        }
        byIntegration.get(post.integrationId)!.push(post);
      }

      // Process each integration
      for (const [intId, posts] of byIntegration.entries()) {
        console.log(
          `[INVALID TIME SLOTS] Processing ${posts.length} posts for integration ${posts[0].integration?.name || intId}`
        );

        for (const post of posts) {
          try {
            // Safety check: Only reschedule QUEUE posts (should already be filtered, but double-check)
            if (post.state && post.state !== 'QUEUE') {
              console.log(`[INVALID TIME SLOTS] ⚠️ Skipping post ${post.id} - state is ${post.state}, not QUEUE`);
              continue;
            }
            
            const postingTimes = post.configuredTimes.map((time: number) => ({ time }));

            // Get next available slot at the end of schedule
            const availableSlot = await this._postsRepository.getNextAvailableSlots(
              post.organizationId,
              post.integrationId,
              1,
              postingTimes,
              true, // searchFromEnd - move to end of schedule
              post.userTimezone || 0 // Pass user's timezone for proper UTC conversion
            );

            if (availableSlot.length === 0) {
              logger.warn(
                `No available slot found for post ${post.id} at invalid time slot`
              );
              console.log(
                `[INVALID TIME SLOTS] ⚠️ No available slot for post ${post.id}`
              );
              continue;
            }

            const newSlot = availableSlot[0];
            const slotTimestamp = dayjs(newSlot).valueOf();

            // Skip if we've already used this slot in this session
            if (usedSlots.has(slotTimestamp)) {
              continue;
            }

            // Update the post's publish date
            await this._postsRepository.updatePostPublishDate(post.id, newSlot);
            usedSlots.add(slotTimestamp);

            // Re-queue the post in the worker
            this._workerServiceProducer.emit('post', {
              id: post.id,
              options: {
                delay: dayjs(newSlot).diff(dayjs(), 'millisecond'),
              },
              payload: {
                id: post.id,
              },
            });

            totalRescheduled++;
            console.log(
              `[INVALID TIME SLOTS] ✓ Rescheduled post ${post.id} from ${dayjs(post.publishDate).format('HH:mm')} (invalid) to ${dayjs(newSlot).format('YYYY-MM-DD HH:mm')} (valid)`
            );
            logger.info(
              `Rescheduled post ${post.id} from invalid time ${dayjs(post.publishDate).format('HH:mm')} to valid time slot ${dayjs(newSlot).format('YYYY-MM-DD HH:mm')}`
            );
          } catch (err) {
            logger.error(
              `Failed to reschedule post ${post.id} at invalid time slot: ${err instanceof Error ? err.message : String(err)}`
            );
            console.error(
              `[INVALID TIME SLOTS] ❌ Error rescheduling post ${post.id}:`,
              err
            );
          }
        }
      }

      console.log(
        `[INVALID TIME SLOTS] ✅ Complete: Rescheduled ${totalRescheduled} of ${invalidPosts.length} posts to valid time slots`
      );
      logger.info(
        `Invalid time slot validation complete: Rescheduled ${totalRescheduled} posts`
      );

      return { rescheduled: totalRescheduled, checked: invalidPosts.length };
    } catch (err) {
      Sentry.captureException(err, {
        extra: {
          context: 'Failed to reschedule posts at invalid time slots',
          orgId,
          integrationId,
        },
      });
      logger.error(
        `Error during invalid time slot validation: ${err instanceof Error ? err.message : String(err)}`
      );
      console.error('[INVALID TIME SLOTS] ❌ Error during validation:', err);
      return { rescheduled: 0, checked: 0 };
    }
  }

  async checkIntegrationConnection(orgId: string, integrationId: string) {
    const { logger } = Sentry;
    
    const integration = await this._integrationRepository.getIntegrationById(
      orgId,
      integrationId
    );

    if (!integration) {
      throw new HttpException('Integration not found', HttpStatus.NOT_FOUND);
    }

    const provider = this._integrationManager.getSocialIntegration(
      integration.providerIdentifier
    );

    if (!provider) {
      throw new HttpException(
        'Provider not supported',
        HttpStatus.BAD_REQUEST
      );
    }

    try {
      // Attempt to refresh the token to verify connection
      const result = await this.refreshToken(provider, integration.refreshToken!);

      if (!result) {
        // Connection failed - mark as needing refresh
        await this._integrationRepository.refreshNeeded(orgId, integrationId);
        await this.informAboutRefreshError(orgId, integration);

        logger.warn(`Manual check failed for integration ${integrationId}`);
        
        return {
          connected: false,
          message: 'Connection failed. The integration has been disconnected by the platform. Please reconnect.',
          refreshNeeded: true,
        };
      }

      // Connection successful - update tokens and mark as good
      const { refreshToken, accessToken, expiresIn } = result;
      await this.createOrUpdateIntegration(
        undefined,
        !!provider.oneTimeToken,
        orgId,
        integration.name,
        integration.picture!,
        'social',
        integration.internalId,
        integration.providerIdentifier,
        accessToken,
        refreshToken,
        expiresIn
      );

      logger.info(`Manual check successful for integration ${integrationId}`);
      
      return {
        connected: true,
        message: 'Connection is active and working properly.',
        refreshNeeded: false,
      };
    } catch (err) {
      // Connection check failed
      await this._integrationRepository.refreshNeeded(orgId, integrationId);
      await this.informAboutRefreshError(
        orgId,
        integration,
        err instanceof Error ? err.message : ''
      );

      logger.error(`Manual check error for integration ${integrationId}: ${err instanceof Error ? err.message : String(err)}`);
      
      return {
        connected: false,
        message: 'Connection check failed. Please reconnect the integration.',
        refreshNeeded: true,
        error: err instanceof Error ? err.message : 'Unknown error',
      };
    }
  }
}
