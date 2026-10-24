import { envValidationSchema } from './env.validation';

const requiredEnv = {
  DB_USERNAME: 'user',
  DB_PASSWORD: 'pass',
  DB_NAME: 'db',
  JWT_SECRET: 'secret',
  JWT_REFRESH_SECRET: 'refresh-secret',
  S3_ACCESS_KEY: 'minioadmin',
  S3_SECRET_KEY: 'minioadmin',
};

const validate = (env: Record<string, string>) =>
  envValidationSchema.validate(
    { ...requiredEnv, ...env },
    { allowUnknown: true, abortEarly: false },
  );

describe('envValidationSchema — SWAGGER_ENABLED', () => {
  it('should reject SWAGGER_ENABLED with an invalid value', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'invalid' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('SWAGGER_ENABLED');
  });

  it('should accept SWAGGER_ENABLED=true', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'true' });
    expect(error).toBeUndefined();
  });

  it('should accept SWAGGER_ENABLED=false', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'false' });
    expect(error).toBeUndefined();
  });

  it('should apply default false when SWAGGER_ENABLED is not set', () => {
    const { value, error } = validate({});
    expect(error).toBeUndefined();
    expect(value.SWAGGER_ENABLED).toBe('false');
  });
});

describe('envValidationSchema — Phase 03 (Storage, Queue, Upload)', () => {
  it('should reject when S3_ACCESS_KEY or S3_SECRET_KEY is missing', () => {
    const {
      S3_ACCESS_KEY: _a,
      S3_SECRET_KEY: _s,
      ...withoutS3Creds
    } = requiredEnv;
    const { error } = envValidationSchema.validate(withoutS3Creds, {
      allowUnknown: true,
      abortEarly: false,
    });
    expect(error).toBeDefined();
    expect(error!.message).toContain('S3_ACCESS_KEY');
    expect(error!.message).toContain('S3_SECRET_KEY');
  });

  it('should apply defaults for storage, queue, and upload variables', () => {
    const { value, error } = validate({});
    expect(error).toBeUndefined();
    expect(value.S3_ENDPOINT).toBe('http://minio:9000');
    expect(value.S3_PUBLIC_ENDPOINT).toBe('http://localhost:9000');
    expect(value.S3_REGION).toBe('us-east-1');
    expect(value.S3_BUCKET).toBe('streamtube-media');
    expect(value.REDIS_HOST).toBe('redis');
    expect(value.REDIS_PORT).toBe(6379);
    expect(value.UPLOAD_MAX_SIZE_BYTES).toBe(10737418240);
    expect(value.UPLOAD_PART_SIZE_BYTES).toBe(67108864);
    expect(value.UPLOAD_URL_TTL_SECONDS).toBe(3600);
    expect(value.DOWNLOAD_URL_TTL_SECONDS).toBe(3600);
    expect(value.VIDEO_WORKER_CONCURRENCY).toBe(2);
  });
});
