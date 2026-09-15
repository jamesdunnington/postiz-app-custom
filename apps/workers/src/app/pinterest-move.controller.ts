import { Controller } from '@nestjs/common';
import { EventPattern, Transport } from '@nestjs/microservices';
import { PinterestMoveService } from '@gitroom/nestjs-libraries/database/prisma/pinterest-move/pinterest-move.service';

@Controller()
export class PinterestMoveController {
  constructor(private _pinterestMoveService: PinterestMoveService) {}

  @EventPattern('pinterest-move-pin', Transport.REDIS)
  async pinterestMovePin(data: { itemId: string }) {
    try {
      return await this._pinterestMoveService.processItem(data.itemId);
    } catch (err) {
      console.log(
        "Unhandled error, let's avoid crashing the pinterest-move-pin worker",
        err
      );
    }
  }
}
