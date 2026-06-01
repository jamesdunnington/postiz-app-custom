import { Injectable } from '@nestjs/common';
import { GlobalSettingsRepository } from '@gitroom/nestjs-libraries/database/prisma/global-settings/global-settings.repository';

export interface LlmSettings {
  provider: 'openai' | 'openrouter';
  apiKey: string;
  textModel: string;
}

@Injectable()
export class GlobalSettingsService {
  constructor(private _repo: GlobalSettingsRepository) {}

  async getLlmSettings(): Promise<LlmSettings> {
    const values = await this._repo.getMany([
      'llm_provider',
      'llm_api_key',
      'llm_text_model',
    ]);

    return {
      provider: (values['llm_provider'] as LlmSettings['provider']) || 'openai',
      apiKey: values['llm_api_key'] || process.env.OPENAI_API_KEY || '',
      textModel: values['llm_text_model'] || 'gpt-4.1',
    };
  }

  async setLlmSettings(settings: Partial<LlmSettings>): Promise<void> {
    const tasks: Promise<void>[] = [];
    if (settings.provider !== undefined) {
      tasks.push(this._repo.set('llm_provider', settings.provider));
    }
    if (settings.apiKey !== undefined && settings.apiKey !== '') {
      tasks.push(this._repo.set('llm_api_key', settings.apiKey));
    }
    if (settings.textModel !== undefined) {
      tasks.push(this._repo.set('llm_text_model', settings.textModel));
    }
    await Promise.all(tasks);
  }

  async getLlmSettingsForDisplay(): Promise<Omit<LlmSettings, 'apiKey'> & { hasApiKey: boolean }> {
    const settings = await this.getLlmSettings();
    return {
      provider: settings.provider,
      textModel: settings.textModel,
      hasApiKey: !!settings.apiKey,
    };
  }
}
