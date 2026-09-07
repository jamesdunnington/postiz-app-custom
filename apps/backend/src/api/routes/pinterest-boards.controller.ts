import { Body, Controller, Post } from '@nestjs/common';
import { Organization } from '@prisma/client';
import { GetOrgFromRequest } from '@gitroom/nestjs-libraries/user/org.from.request';
import { PinterestBoardsService } from '@gitroom/nestjs-libraries/database/prisma/pinterest-boards/pinterest-boards.service';
import { PinterestBoardCreateDto } from '@gitroom/nestjs-libraries/dtos/pinterest-boards/pinterest.board.create.dto';

@Controller('/pinterest-boards')
export class PinterestBoardsController {
  constructor(private _pinterestBoardsService: PinterestBoardsService) {}

  @Post('/create')
  createBoards(
    @GetOrgFromRequest() org: Organization,
    @Body() body: PinterestBoardCreateDto
  ) {
    return this._pinterestBoardsService.createBoards(
      org.id,
      body.integrationId,
      body.boards
    );
  }
}
