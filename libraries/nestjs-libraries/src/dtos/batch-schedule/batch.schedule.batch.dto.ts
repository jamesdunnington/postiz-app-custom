import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsOptional,
  IsString,
  IsUrl,
  ValidateNested,
} from 'class-validator';

export class BatchScheduleRowDto {
  @IsString()
  content: string;

  @IsOptional()
  @IsString()
  title?: string;

  @IsString()
  @IsUrl()
  imageUrl: string;

  @IsString()
  boardId: string;

  @IsOptional()
  @IsString()
  altText?: string;

  @IsOptional()
  @IsString()
  link?: string;

  @IsOptional()
  @IsString()
  scheduledDate?: string;
}

export class BatchScheduleBatchDto {
  @IsString()
  integrationId: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => BatchScheduleRowDto)
  rows: BatchScheduleRowDto[];
}
