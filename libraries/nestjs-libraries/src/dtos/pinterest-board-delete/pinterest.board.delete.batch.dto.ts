import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsString,
  ValidateNested,
} from 'class-validator';

export class PinterestBoardDeleteItemDto {
  @IsString()
  boardId: string;

  @IsString()
  boardName: string;
}

export class PinterestBoardDeleteBatchDto {
  @IsString()
  integrationId: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(25)
  @ValidateNested({ each: true })
  @Type(() => PinterestBoardDeleteItemDto)
  boards: PinterestBoardDeleteItemDto[];
}
