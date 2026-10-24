import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';

export class UploadPartItemDto {
  @ApiProperty({
    description: '1-indexed part number',
    example: 1,
    minimum: 1,
  })
  @IsInt()
  @Min(1)
  part_number: number;

  @ApiProperty({
    description: 'ETag returned by S3/MinIO when the part was uploaded',
    example: '"9bb58f26192e4ba00f01e2e7b136bbd8"',
  })
  @IsString()
  @IsNotEmpty()
  etag: string;
}

export class CompleteUploadDto {
  @ApiProperty({
    description: 'Complete list of uploaded parts with their S3 ETags',
    type: [UploadPartItemDto],
  })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => UploadPartItemDto)
  parts: UploadPartItemDto[];
}
