import { Mastra } from '@mastra/core/mastra';
import { ConsoleLogger } from '@mastra/core/logger';
import { pStore } from '@gitroom/nestjs-libraries/chat/mastra.store';
import { Injectable } from '@nestjs/common';
import { LoadToolsService } from '@gitroom/nestjs-libraries/chat/load.tools.service';

@Injectable()
export class MastraService {
  constructor(private _loadToolsService: LoadToolsService) {}

  // Recreated per-request so LLM settings changes take effect immediately
  async mastra() {
    return new Mastra({
      storage: pStore,
      agents: {
        postiz: await this._loadToolsService.agent(),
      },
      logger: new ConsoleLogger({
        level: 'info',
      }),
    });
  }
}
