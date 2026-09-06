import { Controller } from '@nestjs/common';
import { EventPattern, Transport } from '@nestjs/microservices';
import { PinterestDeleteService } from '@gitroom/nestjs-libraries/database/prisma/pinterest-delete/pinterest-delete.service';

@Controller()
export class PinterestDeleteController {
  constructor(private _pinterestDeleteService: PinterestDeleteService) {}

  @EventPattern('pinterest-delete-pin', Transport.REDIS)
  async pinterestDeletePin(data: { itemId: string }) {
    try {
      return await this._pinterestDeleteService.processItem(data.itemId);
    } catch (err) {
      console.log(
        "Unhandled error, let's avoid crashing the pinterest-delete-pin worker",
        err
      );
    }
  }
}
