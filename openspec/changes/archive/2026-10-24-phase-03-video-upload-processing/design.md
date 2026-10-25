# Design

## Context

- O código fica em `mba-ia-greenfield-project/` (clone do repositório base, branch `main`). O planejamento OpenSpec fica na raiz do workspace. Backend: NestJS 11, TypeORM 0.3 e PostgreSQL 17 em `nestjs-project/`. Hoje o `compose.yaml` só tem `nestjs-api` (imagem `node:25.6.0-slim`, `CMD tail -f /dev/null`, código montado em volume), `db` e `mailpit`.
- Padrões já estabelecidos que esta fase reaproveita:
  - namespaces de config com `registerAs` e validação Joi em `env.validation.ts`;
  - `DomainException` mais `DomainExceptionFilter`, com envelope `{ statusCode, error, message }`;
  - `JwtAuthGuard` global com opt-out `@Public()`, mais `ThrottlerGuard` global de 10 req/min com `@SkipThrottle()` pontual;
  - `@CurrentUser()` devolvendo `{ sub, email }`;
  - repository pattern via `TypeOrmModule.forFeature` no módulo dono;
  - migrations geradas e revisadas;
  - `createTestDataSource` e `cleanAllTables` nos testes;
  - testes `*.spec.ts`, `*.integration-spec.ts` e `*.e2e-spec.ts` rodando no container com `--runInBand`.
- Restrições do `CLAUDE.md`: hosts sempre pelo nome do serviço no Compose; consultar a doc via context7 antes de usar qualquer lib; Definition of Done = suíte verde + `npx tsc --noEmit` + `npm run lint`; Git Flow (`feature/*` a partir de `dev`).
- Decisão anterior que esta fase respeita: `technical-decisions-next-frontend-config-base.md` já prevê que vídeos sejam servidos por **URLs pré-assinadas do object storage**, e não pela API. O diagrama C4 também mostra "Frontend → Object Storage: Streams".
- Motivação e escopo: ver `proposal.md`. Requisitos: ver `specs/videos/*`.

## Goals / Non-Goals

**Goals:**
- Manter a API fora do caminho dos bytes de vídeo, tanto no upload quanto no streaming e no download.
- Ter um worker isolado da API, que escala de forma independente (`concurrency`, réplicas) e reaproveita entidades, config e convenções do mesmo código.
- Testar com infraestrutura real do Compose (MinIO, Redis, FFmpeg), sem mocks onde dá para usar o serviço de verdade.
- Gerar artefatos de planejamento que sejam a fonte do plano `SI-03.x` em `docs/phases/phase-03-videos/`.

**Non-Goals:**
- Transcodificação, renditions e HLS/DASH, ou seja, streaming adaptativo. O streaming desta fase é progressivo via HTTP Range.
- Abortar upload pela API e excluir vídeos. Uploads multipart incompletos são limpos pela expiração automática do MinIO (`stale uploads`).
- Publicação, visibilidade, edição e listagem de vídeos do canal (Fase 04). Contagem de views (Fase 05).
- Antivírus ou validação profunda de conteúdo além do `ffprobe`.

## Decisions

### D1 — Fila: BullMQ + Redis (`@nestjs/bullmq`)
- **Escolha:** Redis 7 (`redis:7-alpine`, `--maxmemory-policy noeviction --appendonly yes`) como backend da fila, com BullMQ e `@nestjs/bullmq`.
- **Por quê:** tem integração oficial com NestJS (`BullModule.forRootAsync`, `registerQueue`, `@Processor`/`WorkerHost`). Já traz retries com backoff exponencial, `jobId` para deduplicação, `UnrecoverableError` para falhas definitivas, concorrência configurável e eventos de falha. Exige só um serviço leve a mais no Compose.
- **Alternativas:**
  - **RabbitMQ:** roteamento mais rico e garantias AMQP, mas sem retry com backoff nativo (precisa de DLX/TTL manual) e com mais operação do que o necessário.
  - **SQS + LocalStack:** se aproxima da produção na AWS, mas emular localmente é pesado e prende o projeto a um provedor.
  - **Fila em PostgreSQL (pg-boss):** não adiciona serviço, mas o diagrama já prevê um container de fila e o tráfego de polling iria para o banco transacional.
- O registro completo, com prós e contras, vai para `docs/decisions/technical-decisions-phase-03-videos.md` (TD de fila).

### D2 — Upload: S3 Multipart com URLs pré-assinadas por parte
- **Fluxo:**
  1. `POST /videos`: a API valida a requisição, cria o vídeo em `draft`, faz `CreateMultipartUpload` (`ContentType` = `mime_type`), salva o `upload_id` e devolve as URLs pré-assinadas de `UploadPart` para todas as partes.
  2. O cliente envia com `PUT` cada parte direto ao MinIO e guarda os `ETag`s.
  3. `POST /videos/:slug/upload/parts`: renova URLs de partes (no máximo 100 por chamada).
  4. `POST /videos/:slug/upload/complete`: a API faz `CompleteMultipartUpload` e depois `HeadObject` para conferir `ContentLength === size_bytes`.
- **Tamanho de parte:** fixo e configurável, `UPLOAD_PART_SIZE_BYTES`, padrão 64 MiB. Com 10 GiB isso dá 160 partes, longe do limite de 10.000. O mínimo do S3 é 5 MiB por parte, exceto a última, então os testes usam 5 MiB. `part_count = max(1, ceil(size/part_size))`.
- **Por quê:** é o padrão da indústria para arquivos grandes. A API só troca JSON pequeno. Um upload interrompido retoma por parte. As URLs expiram (`UPLOAD_URL_TTL_SECONDS`, padrão 3600) e podem ser renovadas, o que cobre uploads longos de 10 GB.
- **Alternativas:**
  - **Upload via API (stream ou multer):** prende conexões e banda da API. Está na lista de reprovação automática.
  - **Um único PUT pré-assinado:** limite de 5 GB por PUT no S3 e sem retomada.
  - **tus/resumable via API:** traz de volta os bytes para a API.

### D3 — Dois clientes S3: interno e público
- **Problema:** a assinatura SigV4 inclui o host. A API e o worker falam com `http://minio:9000` (nome do serviço, como manda o `CLAUDE.md`), mas o cliente HTTP do usuário (navegador ou host) só alcança `http://localhost:9000`.
- **Escolha:** o `StorageService` mantém um `S3Client` interno (`S3_ENDPOINT=http://minio:9000`) para operações de servidor (`Create`/`Complete`/`Head`/`Put`/`Delete`/`GetObject`) e um cliente usado só para **assinar** URLs, com `S3_PUBLIC_ENDPOINT` (padrão `http://localhost:9000`, como `APP_URL`). Os dois usam `forcePathStyle: true`. Nos testes e2e que seguem redirecionamentos de dentro do container, `S3_PUBLIC_ENDPOINT` é sobrescrito para `http://minio:9000`.
- **Alternativa:** proxy reverso ou hostname único resolvível dentro e fora do Docker. Seria mais frágil e mudaria o `/etc/hosts` do desenvolvedor.

### D4 — Layout no storage
- **Escolha:** um bucket privado, `S3_BUCKET=streamtube-media`, criado pelo serviço one-shot `minio-init` (`minio/mc`: `mc mb --ignore-existing`). Chaves:
  - `videos/{videoId}/source`: original. O tipo fica no `Content-Type` do objeto.
  - `videos/{videoId}/thumbnail.jpg`: thumbnail.
- **Por quê:** a chave é derivada do `id` imutável e não do nome enviado pelo usuário, o que evita path traversal e colisões. Um único bucket simplifica política e lifecycle.

### D5 — Worker: mesmo código, entrypoint e container separados
- **Escolha:** `src/worker.ts` executa `NestFactory.createApplicationContext(WorkerModule)`, sem servidor HTTP. O `WorkerModule` importa `ConfigModule`, `TypeOrmModule`, `BullModule`, `StorageModule` e o `VideoProcessor` (`@Processor('video-processing')`, que estende `WorkerHost`).
- **Compose:** novo serviço `video-worker` com o mesmo build (`Dockerfile.dev`) e o mesmo volume, `command: npm run start:worker:dev` (`nest start --watch --entryFile worker`), `restart: unless-stopped`, e `depends_on` com `db`, `redis` e `minio-init` saudáveis ou concluídos.
- **`Dockerfile.dev`:** passa a instalar `ffmpeg`. Assim o `nestjs-api` também tem `ffprobe`/`ffmpeg`, o que é necessário porque os testes de integração do processor rodam nesse container.
- **Por quê:** reaproveita entidades, config, migrations e lint sem um segundo projeto, e isola a CPU do FFmpeg do processo da API.
- **Alternativas:** um projeto Node separado (duplicaria entidades e config); um worker dentro do processo da API (o FFmpeg disputaria CPU com as requisições, o que contraria "sem travar").

### D6 — FFmpeg via `child_process.spawn`, lendo por HTTP Range
- **Escolha:** um `FfmpegService` fino, com `spawn` e timeout:
  - **Metadados:** `ffprobe -v error -print_format json -show_format -show_streams <url>`.
  - **Thumbnail:** `ffmpeg -ss <t> -i <url> -frames:v 1 -vf scale='min(1280,iw)':-2 -f image2 -c:v mjpeg pipe:1`, com o JPEG vindo do stdout e indo para o storage com `PutObject`.
  - `<url>` é uma URL **pré-assinada interna** (`http://minio:9000/...`). O ffmpeg lê só os trechos de que precisa via Range, sem baixar os 10 GB para o disco.
  - `t = min(1, duration*0.1)`.
- **Por quê:** o `fluent-ffmpeg` foi arquivado e não tem mais manutenção, e o wrapper próprio é pequeno e fácil de testar.
- **Mapeamento:** de `ffprobe` para `duration_seconds` (`format.duration`) e para `metadata`: `{ width, height, video_codec, audio_codec|null, container, bitrate, frame_rate }`. Sem stream de vídeo, o processor lança `UnrecoverableError('NO_VIDEO_STREAM')`.

### D7 — Ciclo de status, retries e idempotência
- **Enum `video_status`:** `draft | processing | ready | failed`. As transições permitidas estão em `specs/videos/video-processing` e são aplicadas no service ou processor com `UPDATE ... WHERE status = <esperado>`, uma checagem otimista.
- **`complete`:** dentro de `dataSource.transaction`, faz `UPDATE status='processing', uploaded_at=now(), upload_id=null WHERE id=? AND status='draft'`. Se 0 linhas forem afetadas, devolve `409`. Em seguida chama `queue.add('process-video', { videoId }, { jobId: videoId, attempts: 3, backoff: { type: 'exponential', delay: 5000 }, removeOnComplete: true, removeOnFail: 100 })`. Se `add` lançar erro, a transação faz rollback.
- **Worker:**
  - carrega o vídeo; se `status !== 'processing'`, encerra o job sem erro;
  - no sucesso, faz `UPDATE ... WHERE status='processing'`;
  - no handler `failed` do worker, quando `job.attemptsMade >= attempts` ou o erro é `UnrecoverableError`, marca `failed` com `failure_reason` truncado em 500 caracteres.
- **Por quê:** `jobId = videoId` deduplica jobs. A checagem de status torna as reentregas inofensivas. O rollback ao falhar o enfileiramento evita um vídeo `processing` sem job.

### D8 — URL única: slug aleatório de 11 caracteres
- **Escolha:** `crypto.randomBytes(8).toString('base64url')` gera 11 caracteres e 64 bits de entropia, no estilo do YouTube. Fica em `varchar(11) UNIQUE`. Em caso de violação única (`23505` no `slug`), o sistema gera outro slug, com até 5 tentativas, seguindo o padrão de `ChannelsService` (pré-checagem mais captura de `QueryFailedError`).
- **Por quê:** é imprevisível (não enumerável, diferente de ids sequenciais), curto e seguro em URL. O `id` UUID continua como PK interna. Usar o slug como identificador público em todas as rotas `/videos/:slug` evita misturar UUID e slug no mesmo segmento de rota.
- **Alternativas:** slug a partir do título (colide, muda quando o título muda e só faz sentido na Fase 04); UUID na URL (longo); nanoid (dependência extra sem ganho).

### D9 — Streaming, download e thumbnail por redirect `302` para URL pré-assinada
- **Escolha:**
  - `GET /videos/:slug/stream`: `302` para `GetObject` pré-assinado com `ResponseContentType = mime_type`.
  - `GET /videos/:slug/download`: `302` com `ResponseContentDisposition = attachment; filename="<original_filename>"` (com `filename*=UTF-8''` para nomes não ASCII).
  - `/thumbnail`: `302` para o JPEG.
  - TTL `DOWNLOAD_URL_TTL_SECONDS`, padrão 3600.
  - Range e `206` ficam por conta do MinIO/S3.
- **Por quê:** segue o diagrama C4 e a decisão anterior do frontend. A API fica sem tráfego de bytes, e o `<video src=".../stream">` do navegador segue o redirect e faz Range direto no storage.
- **Alternativa:** proxy de Range na API (`GetObject` com `Range` e pipe com `206`). Funciona, mas joga toda a banda de vídeo na API. Fica registrada como alternativa no TD.

### D10 — Autenticação opcional em rotas `@Public()`
- **Escolha:** `JwtAuthGuard`, quando a rota é pública e há `Authorization: Bearer`, tenta `verifyAsync`. Se der certo, popula `request.user`. Se falhar, segue anônimo e nunca lança erro em rota pública. O controller passa `user?.sub` ao service, que decide a visibilidade (regra de negócio no service, como pede `nestjs-layer-separation`). `@CurrentUser()` passa a tipar o retorno como `JwtPayload | undefined` em rotas públicas.
- **Alternativa:** um endpoint autenticado separado para o dono, como `GET /me/videos/:slug`. Duplicaria a rota de leitura e quebraria o REST.

### D11 — Rate limiting
- **Escolha:** `VideosController` com `@Throttle({ default: { ttl: 60000, limit: 60 } })`. As rotas `/stream`, `/download` e `/thumbnail` usam `@SkipThrottle()`, porque são redirects baratos que um player pode chamar com frequência. O limite global de 10/min do Phase 02 continua valendo para auth.

### D12 — Módulos e camadas
- **`src/storage/`:** `StorageModule` exporta `StorageService` (multipart, presign, head, put, delete). É infraestrutura sem regra de negócio.
- **`src/videos/`:** `VideosModule` contém `TypeOrmModule.forFeature([Video])`, `ChannelsModule`, `StorageModule` e `BullModule.registerQueue({ name: 'video-processing' })`, mais `VideosController`, `VideosService`, `dto/`, `entities/video.entity.ts`, `videos.constants.ts` (nome da fila e do job, tipos MIME, limites) e `video.exceptions.ts`. As exceções de domínio estendem `DomainException`.
- **`src/video-worker/`:** `WorkerModule`, `video.processor.ts` e `ffmpeg.service.ts`. Importa a entidade `Video` via `TypeOrmModule.forFeature`.
- **`ChannelsService`:** ganha `findByUserId(userId)`, para que o vídeo seja ligado ao canal do usuário autenticado sem que `VideosService` consulte `channels` diretamente.
- **Config:**
  - `storage.config.ts`: `S3_ENDPOINT`, `S3_PUBLIC_ENDPOINT`, `S3_REGION` (padrão `us-east-1`), `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_BUCKET`;
  - `queue.config.ts`: `REDIS_HOST=redis`, `REDIS_PORT=6379`;
  - `upload.config.ts`: `UPLOAD_MAX_SIZE_BYTES=10737418240`, `UPLOAD_PART_SIZE_BYTES=67108864`, `UPLOAD_URL_TTL_SECONDS=3600`, `DOWNLOAD_URL_TTL_SECONDS=3600`, `VIDEO_WORKER_CONCURRENCY=2`;
  - todas no Joi e no `.env.example`.

### D13 — Modelo de dados (`videos`)
| Coluna | Tipo | Restrições |
|---|---|---|
| id | uuid | PK, gerado |
| channel_id | uuid | FK → channels.id, `ON DELETE CASCADE`, not null, índice |
| slug | varchar(11) | unique, not null |
| title | varchar(100) | not null |
| status | enum `video_status` | not null, padrão `draft`, índice |
| original_filename | varchar(255) | not null |
| mime_type | varchar(100) | not null |
| size_bytes | bigint | not null (transformer para `number`, seguro até 2^53) |
| storage_key | varchar(512) | not null |
| upload_id | varchar(1024) | nullable (zerado no `complete`) |
| thumbnail_key | varchar(512) | nullable |
| duration_seconds | numeric(10,3) | nullable (transformer para `number`) |
| metadata | jsonb | nullable |
| failure_reason | varchar(500) | nullable |
| uploaded_at / processed_at | timestamp | nullable |
| created_at / updated_at | timestamp | auto |

Relação: `Video` `@ManyToOne` com `Channel`, com `@JoinColumn({ name: 'channel_id' })`. Nesta fase não é criada a relação inversa em `Channel`.

### D14 — Events/Messages
| Campo | Valor |
|---|---|
| Fila | `video-processing` (Redis, prefixo padrão do BullMQ) |
| Job name | `process-video` |
| Payload | `{ videoId: string (uuid) }`. O worker lê o resto do banco, que é a fonte da verdade. |
| jobId | `videoId` (deduplicação) |
| Produtor | `VideosService.completeUpload` (API) |
| Consumidor | `VideoProcessor` (`video-worker`), `concurrency = VIDEO_WORKER_CONCURRENCY` |
| Retry | `attempts: 3`, backoff exponencial de 5s; `UnrecoverableError` para `NO_VIDEO_STREAM` |
| Efeitos | sucesso → `ready` mais metadados e thumbnail; falha final → `failed` mais `failure_reason` |

### D15 — Estratégia de testes
- **Unit (`*.spec.ts`):** `VideosService` (cálculo de partes, título derivado, regras de visibilidade e status, mapeamento de erros do S3, rollback quando o enfileiramento falha), slug util, parser de `ffprobe` para metadados, `VideoProcessor` com colaboradores mockados (pular status não `processing`, `UnrecoverableError`), `JwtAuthGuard` (auth opcional).
- **Integration (`*.integration-spec.ts`):** entidade e migration `videos` (unique slug, enum, FK e cascade); `StorageService` contra MinIO real (multipart de 2 partes: 5 MiB + 1 MiB; presign; head); `FfmpegService` e `VideoProcessor` com MinIO e Redis reais, usando um fixture gerado em tempo de teste (`ffmpeg -f lavfi -i testsrc=duration=2:size=320x240:rate=25 -f lavfi -i sine=duration=2 ...`, sem binário versionado) e um arquivo não vídeo para o caminho `failed`; `migrations.integration-spec.ts` atualizado.
- **E2E (`test/videos.e2e-spec.ts`):** fluxo completo `POST /videos` → `PUT` das partes no MinIO → `complete` → espera (polling com timeout) até `ready`, com o processor do worker rodando no próprio teste via `WorkerModule` → `GET /videos/:slug` → `/stream` com `Range` (`206`) → `/download` (`Content-Disposition`) → `/thumbnail` (`image/jpeg`). Inclui erros (`401`, `400` acima de 10 GiB e tipo MIME, `404` para não dono, `409` para complete repetido) e visibilidade anônima.
- `cleanAllTables` passa a limpar `videos` primeiro. Os testes que usam storage limpam os objetos dos ids criados e a fila (`queue.obliterate({ force: true })`).

## Risks / Trade-offs

- [URL pré-assinada com host diferente dentro e fora do Docker] → dois clientes S3 (D3) e `S3_PUBLIC_ENDPOINT` explícito no `.env.example` e no `CLAUDE.md`. Os testes sobrescrevem para `minio:9000`.
- [`bigint`/`numeric` do Postgres chegam como `string` no TypeORM] → transformers de coluna, com teste de integração cobrindo.
- [Commit da transação falha depois de `queue.add`] → o worker encontra o vídeo fora de `processing`, encerra o job sem efeito e o vídeo continua `draft`, de modo que o dono pode iniciar outro upload. A janela é mínima e está documentada. Um outbox fica como melhoria futura.
- [Uploads abandonados ocupam espaço com partes órfãs] → expiração de uploads multipart incompletos do MinIO (padrão de 24h). Vídeos `draft` antigos continuam no banco nesta fase (limpeza fica para a Fase 04).
- [FFmpeg lendo via HTTP um MP4 com `moov` no fim] → o ffmpeg faz seeks com Range. Timeout do processo (`spawn` mais kill) e retry cobrem lentidão.
- [Worker sobe antes do `npm install` no volume compartilhado] → `restart: unless-stopped` mais documentação da ordem (instalar dependências no `nestjs-api` e depois o worker estabiliza).
- [Testes que precisam de FFmpeg rodam no `nestjs-api`] → o `ffmpeg` entra no `Dockerfile.dev` compartilhado, o que exige rebuild (`docker compose build`), documentado no `CLAUDE.md`.
- [Rate limit global de 10/min atrapalharia os players] → override e skip no `VideosController` (D11).
- [Quem tem o slug acessa o vídeo pronto, porque visibilidade e publicação ainda não existem] → aceito nesta fase, já que o slug tem 64 bits e não é enumerável. A Fase 04 traz visibilidade e publicação.

## Migration Plan

1. Na branch `feature/phase-03-videos`, criada a partir de `dev` (sincronizar `dev` com `main` antes, porque `origin/dev` está atrás de `main`).
2. `docker compose build` (imagem com ffmpeg) e `docker compose up -d`; `docker compose exec nestjs-api npm install`; `npm run migration:run` (`CreateVideos`).
3. Rollback: `npm run migration:revert` remove a tabela `videos` e o enum `video_status`. Remover os serviços novos do Compose não afeta auth, users ou channels.
