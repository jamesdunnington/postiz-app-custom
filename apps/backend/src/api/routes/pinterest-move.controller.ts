import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { Organization, User } from '@prisma/client';
import { GetOrgFromRequest } from '@gitroom/nestjs-libraries/user/org.from.request';
import { GetUserFromRequest } from '@gitroom/nestjs-libraries/user/user.from.request';
import { PinterestMoveService } from '@gitroom/nestjs-libraries/database/prisma/pinterest-move/pinterest-move.service';
import { PinterestMoveBatchDto } from '@gitroom/nestjs-libraries/dtos/pinterest-move/pinterest.move.batch.dto';
import { PinterestMoveCancelDto } from '@gitroom/nestjs-libraries/dtos/pinterest-move/pinterest.move.cancel.dto';
import { PinterestMovePaceDto } from '@gitroom/nestjs-libraries/dtos/pinterest-move/pinterest.move.pace.dto';

@Controller('/pinterest-move')
export class PinterestMoveController {
  constructor(private _pinterestMoveService: PinterestMoveService) {}

  @Post('/batches')
  createBatch(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Body() body: PinterestMoveBatchDto
  ) {
    return this._pinterestMoveService.createBatch(
      org.id,
      body.integrationId,
      user.id,
      'MANUAL',
      body.targetBoardId,
      body.targetBoardName,
      body.pins
    );
  }

  @Get('/queue')
  getQueue(@Query('integrationId') integrationId: string) {
    return this._pinterestMoveService.listQueueSummary(integrationId);
  }

  @Get('/pace')
  getPace(
    @GetOrgFromRequest() org: Organization,
    @Query('integrationId') integrationId: string
  ) {
    return this._pinterestMoveService.getPacingSettings(org.id, integrationId);
  }

  @Post('/pace')
  updatePace(
    @GetOrgFromRequest() org: Organization,
    @Body() body: PinterestMovePaceDto
  ) {
    return this._pinterestMoveService.updatePacingSettings(
      org.id,
      body.integrationId,
      {
        minMinutes: body.minMinutes,
        maxMinutes: body.maxMinutes,
        batchSize: body.batchSize,
      }
    );
  }

  @Post('/cancel')
  cancel(
    @GetOrgFromRequest() org: Organization,
    @Body() body: PinterestMoveCancelDto
  ) {
    return this._pinterestMoveService.cancelItems(
      org.id,
      body.integrationId,
      body.itemIds
    );
  }
}
