import { ArgumentMetadata, ValidationPipe } from '@nestjs/common';
import { CreateVideoDto } from './create-video.dto';
import { PresignPartsDto } from './presign-parts.dto';
import { CompleteUploadDto } from './complete-upload.dto';

describe('Video DTOs ValidationPipe', () => {
  const pipe = new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
  });

  const meta = (metatype: any): ArgumentMetadata => ({
    type: 'body',
    metatype,
  });

  describe('CreateVideoDto', () => {
    it('accepts valid payload up to 10 GiB (10737418240 bytes)', async () => {
      const dto = await pipe.transform(
        {
          filename: 'aula.mp4',
          size_bytes: 10737418240,
          mime_type: 'video/mp4',
          title: 'Aula 1',
        },
        meta(CreateVideoDto),
      );
      expect(dto.size_bytes).toBe(10737418240);
    });

    it('rejects size_bytes above 10 GiB (10737418241)', async () => {
      await expect(
        pipe.transform(
          {
            filename: 'huge.mp4',
            size_bytes: 10737418241,
            mime_type: 'video/mp4',
          },
          meta(CreateVideoDto),
        ),
      ).rejects.toThrow();
    });

    it('rejects size_bytes <= 0', async () => {
      await expect(
        pipe.transform(
          {
            filename: 'empty.mp4',
            size_bytes: 0,
            mime_type: 'video/mp4',
          },
          meta(CreateVideoDto),
        ),
      ).rejects.toThrow();
    });

    it('rejects unsupported mime_type (image/png)', async () => {
      await expect(
        pipe.transform(
          {
            filename: 'photo.png',
            size_bytes: 1024,
            mime_type: 'image/png',
          },
          meta(CreateVideoDto),
        ),
      ).rejects.toThrow();
    });
  });

  describe('PresignPartsDto', () => {
    it('accepts unique positive integer part_numbers (1..100 items)', async () => {
      const dto = await pipe.transform(
        { part_numbers: [1, 3, 5] },
        meta(PresignPartsDto),
      );
      expect(dto.part_numbers).toEqual([1, 3, 5]);
    });

    it('rejects duplicate part_numbers or empty array', async () => {
      await expect(
        pipe.transform({ part_numbers: [1, 1] }, meta(PresignPartsDto)),
      ).rejects.toThrow();

      await expect(
        pipe.transform({ part_numbers: [] }, meta(PresignPartsDto)),
      ).rejects.toThrow();
    });
  });

  describe('CompleteUploadDto', () => {
    it('accepts valid parts list', async () => {
      const dto = await pipe.transform(
        {
          parts: [
            { part_number: 1, etag: '"etag1"' },
            { part_number: 2, etag: '"etag2"' },
          ],
        },
        meta(CompleteUploadDto),
      );
      expect(dto.parts).toHaveLength(2);
    });

    it('rejects empty parts array or missing etag', async () => {
      await expect(
        pipe.transform({ parts: [] }, meta(CompleteUploadDto)),
      ).rejects.toThrow();

      await expect(
        pipe.transform(
          { parts: [{ part_number: 1, etag: '' }] },
          meta(CompleteUploadDto),
        ),
      ).rejects.toThrow();
    });
  });
});
