import { Controller } from '@nestjs/common';
import { EventPattern, Transport } from '@nestjs/microservices';
import { BatchScheduleService } from '@gitroom/nestjs-libraries/database/prisma/batch-schedule/batch-schedule.service';

@Controller()
export class BatchScheduleController {
  constructor(private _batchScheduleService: BatchScheduleService) {}

  @EventPattern('batch-schedule-item', Transport.REDIS)
  async batchScheduleItem(data: { itemId: string }) {
    try {
      return await this._batchScheduleService.processItem(data.itemId);
    } catch (err) {
      console.log(
        "Unhandled error, let's avoid crashing the batch-schedule-item worker",
        err
      );
    }
  }
}
