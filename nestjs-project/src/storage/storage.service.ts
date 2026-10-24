import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import storageConfig from '../config/storage.config';

export interface PresignedPartUrl {
  part_number: number;
  url: string;
}

export interface CompletedPartInput {
  part_number: number;
  etag: string;
}

export interface HeadObjectResult {
  sizeBytes: number;
  contentType?: string;
}

export interface PresignGetObjectOptions {
  responseContentType?: string;
  responseContentDisposition?: string;
}

@Injectable()
export class StorageService {
  private readonly internalClient: S3Client;
  private readonly publicSignerClient: S3Client;
  private readonly bucket: string;

  constructor(
    @Inject(storageConfig.KEY)
    private readonly config: ConfigType<typeof storageConfig>,
  ) {
    this.bucket = this.config.bucket;

    this.internalClient = new S3Client({
      region: this.config.region,
      endpoint: this.config.endpoint,
      forcePathStyle: true,
      credentials: {
        accessKeyId: this.config.accessKey,
        secretAccessKey: this.config.secretKey,
      },
    });

    this.publicSignerClient = new S3Client({
      region: this.config.region,
      endpoint: this.config.publicEndpoint,
      forcePathStyle: true,
      credentials: {
        accessKeyId: this.config.accessKey,
        secretAccessKey: this.config.secretKey,
      },
    });
  }

  async createMultipartUpload(key: string, mimeType: string): Promise<string> {
    const response = await this.internalClient.send(
      new CreateMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: mimeType,
      }),
    );

    if (!response.UploadId) {
      throw new Error('Failed to initiate multipart upload: missing UploadId');
    }

    return response.UploadId;
  }

  async presignUploadParts(
    key: string,
    uploadId: string,
    partNumbers: number[],
    ttlSeconds: number,
  ): Promise<PresignedPartUrl[]> {
    return Promise.all(
      partNumbers.map(async (partNumber) => {
        const command = new UploadPartCommand({
          Bucket: this.bucket,
          Key: key,
          UploadId: uploadId,
          PartNumber: partNumber,
        });
        const url = await getSignedUrl(this.publicSignerClient, command, {
          expiresIn: ttlSeconds,
        });
        return {
          part_number: partNumber,
          url,
        };
      }),
    );
  }

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: CompletedPartInput[],
  ): Promise<void> {
    const sortedParts = parts
      .slice()
      .sort((a, b) => a.part_number - b.part_number)
      .map((part) => ({
        PartNumber: part.part_number,
        ETag: part.etag,
      }));

    await this.internalClient.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: {
          Parts: sortedParts,
        },
      }),
    );
  }

  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    await this.internalClient.send(
      new AbortMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
      }),
    );
  }

  async headObject(key: string): Promise<HeadObjectResult> {
    const response = await this.internalClient.send(
      new HeadObjectCommand({
        Bucket: this.bucket,
        Key: key,
      }),
    );

    return {
      sizeBytes: response.ContentLength ?? 0,
      contentType: response.ContentType,
    };
  }

  async putObject(
    key: string,
    body: Buffer,
    contentType: string,
  ): Promise<void> {
    await this.internalClient.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  async deleteObject(key: string): Promise<void> {
    await this.internalClient.send(
      new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: key,
      }),
    );
  }

  async presignGetObject(
    key: string,
    ttlSeconds: number,
    options?: PresignGetObjectOptions,
  ): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ResponseContentType: options?.responseContentType,
      ResponseContentDisposition: options?.responseContentDisposition,
    });

    return getSignedUrl(this.publicSignerClient, command, {
      expiresIn: ttlSeconds,
    });
  }

  async presignInternalGetObject(
    key: string,
    ttlSeconds: number,
  ): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
    });

    return getSignedUrl(this.internalClient, command, {
      expiresIn: ttlSeconds,
    });
  }
}
