import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { Organization, User } from '@prisma/client';
import { GetOrgFromRequest } from '@gitroom/nestjs-libraries/user/org.from.request';
import { GetUserFromRequest } from '@gitroom/nestjs-libraries/user/user.from.request';
import { BatchScheduleService } from '@gitroom/nestjs-libraries/database/prisma/batch-schedule/batch-schedule.service';
import { BatchScheduleBatchDto } from '@gitroom/nestjs-libraries/dtos/batch-schedule/batch.schedule.batch.dto';

@Controller('/batch-schedule')
export class BatchScheduleController {
  constructor(private _batchScheduleService: BatchScheduleService) {}

  @Post('/batches')
  createBatch(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Body() body: BatchScheduleBatchDto
  ) {
    return this._batchScheduleService.createBatch(
      org.id,
      body.integrationId,
      user.id,
      body.rows
    );
  }

  @Get('/queue')
  getQueue(@Query('integrationId') integrationId: string) {
    return this._batchScheduleService.listQueueSummary(integrationId);
  }

  @Post('/items/:id/retry')
  retryItem(@Param('id') id: string) {
    return this._batchScheduleService.retryItem(id);
  }
}
