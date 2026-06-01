import { Injectable } from '@nestjs/common';
import { GlobalSettingsService } from '@gitroom/nestjs-libraries/database/prisma/global-settings/global-settings.service';
import OpenAI from 'openai';

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

export interface LlmClientConfig {
  apiKey: string;
  baseURL: string | undefined;
  textModel: string;
  isOpenRouter: boolean;
}

@Injectable()
export class LlmConfigService {
  constructor(private _globalSettings: GlobalSettingsService) {}

  async getConfig(): Promise<LlmClientConfig> {
    const settings = await this._globalSettings.getLlmSettings();
    const isOpenRouter = settings.provider === 'openrouter';
    return {
      apiKey: settings.apiKey,
      baseURL: isOpenRouter ? OPENROUTER_BASE_URL : undefined,
      textModel: settings.textModel,
      isOpenRouter,
    };
  }

  async createOpenAIClient(): Promise<OpenAI> {
    const config = await this.getConfig();
    return new OpenAI({
      apiKey: config.apiKey,
      ...(config.baseURL ? { baseURL: config.baseURL } : {}),
    });
  }
}
