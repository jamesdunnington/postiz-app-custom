import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { Organization, User } from '@prisma/client';
import { GetOrgFromRequest } from '@gitroom/nestjs-libraries/user/org.from.request';
import { GetUserFromRequest } from '@gitroom/nestjs-libraries/user/user.from.request';
import { PinterestDeleteService } from '@gitroom/nestjs-libraries/database/prisma/pinterest-delete/pinterest-delete.service';
import { PinterestDeleteBatchDto } from '@gitroom/nestjs-libraries/dtos/pinterest-delete/pinterest.delete.batch.dto';

@Controller('/pinterest-delete')
export class PinterestDeleteController {
  constructor(private _pinterestDeleteService: PinterestDeleteService) {}

  @Post('/batches')
  createBatch(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Body() body: PinterestDeleteBatchDto
  ) {
    return this._pinterestDeleteService.createBatch(
      org.id,
      body.integrationId,
      user.id,
      'MANUAL',
      body.pins
    );
  }

  @Get('/queue')
  getQueue(@Query('integrationId') integrationId: string) {
    return this._pinterestDeleteService.listQueueSummary(integrationId);
  }
}
