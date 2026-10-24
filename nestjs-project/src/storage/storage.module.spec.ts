import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import storageConfig from '../config/storage.config';
import { StorageModule } from './storage.module';
import { StorageService } from './storage.service';

describe('StorageModule', () => {
  it('should compile and provide StorageService', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [
            () => ({
              storage: {
                endpoint: 'http://minio:9000',
                publicEndpoint: 'http://localhost:9000',
                region: 'us-east-1',
                accessKey: 'minioadmin',
                secretKey: 'minioadmin',
                bucket: 'streamtube-media',
              },
            }),
            storageConfig,
          ],
        }),
        StorageModule,
      ],
    }).compile();

    const storageService = moduleRef.get(StorageService);
    expect(storageService).toBeDefined();
  });
});
