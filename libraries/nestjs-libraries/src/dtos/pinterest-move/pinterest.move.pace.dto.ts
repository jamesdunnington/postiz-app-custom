import { IsInt, IsString, Max, Min } from 'class-validator';

export class PinterestMovePaceDto {
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
