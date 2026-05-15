import { initializeSentry } from '@gitroom/nestjs-libraries/sentry/initialize.sentry';
initializeSentry('workers');

import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { MicroserviceOptions } from '@nestjs/microservices';
import { BullMqServer } from '@gitroom/nestjs-libraries/bull-mq-transport-new/strategy';
import { BullMqClient } from '@gitroom/nestjs-libraries/bull-mq-transport-new/client';
import { PublishingStateService } from '@gitroom/nestjs-libraries/redis/publishing.state.service';

import { AppModule } from './app/app.module';

async function start() {
  process.env.IS_WORKER = 'true';

  // some comment again
  const app = await NestFactory.createMicroservice<MicroserviceOptions>(
    AppModule,
    {
      strategy: new BullMqServer(),
    }
  );

  // Hard-coded: every restart starts in PAUSED mode so an unattended
  // docker compose up never causes a burst of belated posts.
  try {
    const publishingState = app.get(PublishingStateService);
    const bullClient = app.get(BullMqClient);
    await publishingState.setPaused(true);
    await bullClient.getQueue('post').pause();
    Logger.warn(
      'Publishing started in PAUSED mode — call POST /publishing/resume to start sending'
    );
  } catch (err) {
    Logger.error('Failed to set startup pause state', err as any);
  }

  await app.listen();
}

start();
