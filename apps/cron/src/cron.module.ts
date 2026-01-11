import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { DatabaseModule } from '@gitroom/nestjs-libraries/database/prisma/database.module';
import { BullMqModule } from '@gitroom/nestjs-libraries/bull-mq-transport-new/bull.mq.module';
import { SentryModule } from '@sentry/nestjs/setup';
import { FILTER } from '@gitroom/nestjs-libraries/sentry/sentry.exception';
import { CheckMissingQueues } from '@gitroom/cron/tasks/check.missing.queues';
import { PostNowPendingQueues } from '@gitroom/cron/tasks/post.now.pending.queues';
import { RescheduleMissedPostsStartup } from '@gitroom/cron/tasks/reschedule.missed.posts.startup';
import { CheckDuplicateSchedules } from '@gitroom/cron/tasks/check.duplicate.schedules';
import { CheckInvalidTimeSlots } from '@gitroom/cron/tasks/check.invalid.timeslots';

@Module({
  imports: [
    SentryModule.forRoot(),
    DatabaseModule,
    ScheduleModule.forRoot(),
    BullMqModule,
  ],
  controllers: [],
  providers: [FILTER, CheckMissingQueues, PostNowPendingQueues, RescheduleMissedPostsStartup, CheckDuplicateSchedules, CheckInvalidTimeSlots],
})
export class CronModule {}
