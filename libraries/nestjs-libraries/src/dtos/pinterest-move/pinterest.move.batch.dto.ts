import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsOptional,
  IsString,
} from 'class-validator';

export class PinterestMoveBatchDto {
  @IsString()
  integrationId: string;

  @IsString()
  targetBoardId: string;

  @IsOptional()
  @IsString()
  targetBoardName?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @IsString({ each: true })
  pins: string[];
}
