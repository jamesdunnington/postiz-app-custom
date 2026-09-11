import { Controller } from '@nestjs/common';
import { EventPattern, Transport } from '@nestjs/microservices';
import { PinterestBoardDeleteService } from '@gitroom/nestjs-libraries/database/prisma/pinterest-board-delete/pinterest-board-delete.service';

@Controller()
export class PinterestBoardDeleteController {
  constructor(private _pinterestBoardDeleteService: PinterestBoardDeleteService) {}

  @EventPattern('pinterest-delete-board', Transport.REDIS)
  async pinterestDeleteBoard(data: { itemId: string }) {
    try {
      return await this._pinterestBoardDeleteService.processItem(data.itemId);
    } catch (err) {
      console.log(
        "Unhandled error, let's avoid crashing the pinterest-delete-board worker",
        err
      );
    }
  }
}
