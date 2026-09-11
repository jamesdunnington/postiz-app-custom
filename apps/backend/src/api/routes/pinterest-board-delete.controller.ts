import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { Organization, User } from '@prisma/client';
import { GetOrgFromRequest } from '@gitroom/nestjs-libraries/user/org.from.request';
import { GetUserFromRequest } from '@gitroom/nestjs-libraries/user/user.from.request';
import { PinterestBoardDeleteService } from '@gitroom/nestjs-libraries/database/prisma/pinterest-board-delete/pinterest-board-delete.service';
import { PinterestBoardDeleteBatchDto } from '@gitroom/nestjs-libraries/dtos/pinterest-board-delete/pinterest.board.delete.batch.dto';

@Controller('/pinterest-board-delete')
export class PinterestBoardDeleteController {
  constructor(private _pinterestBoardDeleteService: PinterestBoardDeleteService) {}

  @Post('/batches')
  createBatch(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Body() body: PinterestBoardDeleteBatchDto
  ) {
    return this._pinterestBoardDeleteService.createBatch(
      org.id,
      body.integrationId,
      user.id,
      body.boards
    );
  }

  @Get('/queue')
  getQueue(@Query('integrationId') integrationId: string) {
    return this._pinterestBoardDeleteService.listQueueSummary(integrationId);
  }
}
