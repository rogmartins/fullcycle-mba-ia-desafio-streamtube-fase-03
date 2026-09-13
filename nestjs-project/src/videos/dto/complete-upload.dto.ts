import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsInt,
  IsNotEmpty,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';

export class PartDto {
  @IsInt()
  @Min(1)
  part_number: number;

  @IsString()
  @IsNotEmpty()
  etag: string;
}

export class CompleteUploadDto {
  @ValidateNested({ each: true })
  @ArrayMinSize(1)
  @Type(() => PartDto)
  parts: PartDto[];
}
