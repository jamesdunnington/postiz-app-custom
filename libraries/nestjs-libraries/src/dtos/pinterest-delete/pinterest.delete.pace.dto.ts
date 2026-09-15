import { IsInt, IsString, Max, Min } from 'class-validator';

export class PinterestDeletePaceDto {
  @IsString()
  integrationId: string;

  @IsInt()
  @Min(1)
  @Max(1440)
  minMinutes: number;

  @IsInt()
  @Min(1)
  @Max(1440)
  maxMinutes: number;

  @IsInt()
  @Min(1)
  @Max(10)
  batchSize: number;
}
