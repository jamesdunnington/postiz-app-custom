import { Controller, Get, HttpException, Param } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { BullMqClient } from '@gitroom/nestjs-libraries/bull-mq-transport-new/client';

@ApiTags('Monitor')
@Controller('/monitor')
export class MonitorController {
  constructor(private _workerServiceProducer: BullMqClient) {}

  @Get('/queue/:name')
  async getMessagesGroup(@Param('name') name: string) {
    const { valid, issues, counts } =
      await this._workerServiceProducer.checkQueueHealth(name);

    if (valid) {
      return {
        status: 'success',
        message: `Queue ${name} is healthy.`,
        counts,
      };
    }

    throw new HttpException(
      {
        status: 'error',
        message: `Queue ${name} is unhealthy.`,
        issues,
        counts,
      },
      503
    );
  }
}
