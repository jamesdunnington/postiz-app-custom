import { PrismaRepository } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { Injectable } from '@nestjs/common';
import { AuthService } from '@gitroom/helpers/auth/auth.service';

const ENCRYPTED_KEYS = new Set(['llm_api_key']);

@Injectable()
export class GlobalSettingsRepository {
  constructor(private _globalSetting: PrismaRepository<'globalSetting'>) {}

  async get(key: string): Promise<string | null> {
    const row = await this._globalSetting.model.globalSetting.findUnique({
      where: { key },
    });
    if (!row) return null;
    if (ENCRYPTED_KEYS.has(key)) {
      return AuthService.fixedDecryption(row.value);
    }
    return row.value;
  }

  async set(key: string, value: string): Promise<void> {
    const stored = ENCRYPTED_KEYS.has(key)
      ? AuthService.fixedEncryption(value)
      : value;
    await this._globalSetting.model.globalSetting.upsert({
      where: { key },
      create: { key, value: stored },
      update: { value: stored },
    });
  }

  async getMany(keys: string[]): Promise<Record<string, string>> {
    const rows = await this._globalSetting.model.globalSetting.findMany({
      where: { key: { in: keys } },
    });
    return rows.reduce(
      (acc, row) => {
        const value = ENCRYPTED_KEYS.has(row.key)
          ? AuthService.fixedDecryption(row.value)
          : row.value;
        acc[row.key] = value;
        return acc;
      },
      {} as Record<string, string>
    );
  }
}
