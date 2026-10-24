import { ApiProperty } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsInt,
  Min,
} from 'class-validator';
import { MAX_PRESIGN_PARTS_PER_REQUEST } from '../videos.constants';

export class PresignPartsDto {
  @ApiProperty({
    description: '1-indexed part numbers to refresh presigned URLs for',
    example: [1, 2],
    type: [Number],
    minItems: 1,
    maxItems: MAX_PRESIGN_PARTS_PER_REQUEST,
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_PRESIGN_PARTS_PER_REQUEST)
  @ArrayUnique()
  @IsInt({ each: true })
  @Min(1, { each: true })
  part_numbers: number[];
}
