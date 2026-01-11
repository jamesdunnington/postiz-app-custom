import { Module } from '@nestjs/common';
import { CommandModule as ExternalCommandModule } from 'nestjs-command';
import { CheckStars } from './tasks/check.stars';
import { DatabaseModule } from '@gitroom/nestjs-libraries/database/prisma/database.module';
import { RefreshTokens } from './tasks/refresh.tokens';
import { BullMqModule } from '@gitroom/nestjs-libraries/bull-mq-transport-new/bull.mq.module';
import { ConfigurationTask } from './tasks/configuration';
import { AgentRun } from './tasks/agent.run';
import { AgentModule } from '@gitroom/nestjs-libraries/agent/agent.module';
import { CleanupFuturePublished } from './tasks/cleanup.future.published';
import { CleanupPostsWithoutImages } from './tasks/cleanup.posts.without.images';
import { CleanupInvalidPosts } from './tasks/cleanup.invalid.posts';

@Module({
  imports: [ExternalCommandModule, DatabaseModule, BullMqModule, AgentModule],
  controllers: [],
  providers: [
    CheckStars, 
    RefreshTokens, 
    ConfigurationTask, 
    AgentRun, 
    CleanupFuturePublished, 
    CleanupPostsWithoutImages,
    CleanupInvalidPosts
  ],
  get exports() {
    return [...this.imports, ...this.providers];
  },
})
export class CommandModule {}
