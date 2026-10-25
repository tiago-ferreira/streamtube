# Tasks

> Código em `mba-ia-greenfield-project/` (abreviado como `repo/`). Todo comando `npm`/`npx` roda com `docker compose exec nestjs-api ...` dentro de `repo/nestjs-project/`. Antes de usar cada lib nova (AWS SDK v3, BullMQ, `@nestjs/bullmq`), consulte a doc via context7 na versão instalada e registre o resultado em `library-refs.md`.

## 1. Setup do repositório, Git Flow e fundação de IA

- [x] 1.1 Aponte o `origin` de `repo/` para o fork público do usuário e mantenha o `devfullcycle` como `upstream`. Atualize `dev` com `main` (hoje `origin/dev` está atrás de `main`) e crie `feature/phase-03-videos` a partir de `dev`. Verifique com `git status` (branch correta) e `git log dev..main` vazio.
- [x] 1.2 Suba a stack atual (`docker compose up -d`, `npm install`, `npm run migration:run`) e confirme a linha de base verde: `npm test -- --runInBand`, `npm run test:e2e`, `npx tsc --noEmit` e `npm run lint` passando antes de qualquer mudança.
- [x] 1.3 Porte a fundação de IA para o Antigravity. Crie `repo/GEMINI.md` e `repo/nestjs-project/GEMINI.md` (ou `AGENTS.md`) equivalentes aos `CLAUDE.md`. Espelhe `.claude/skills/*` em `.agents/skills/*` e `.claude/rules/*` em `.agents/rules/*` (convertendo o frontmatter `paths:` para o trigger equivalente). Converta `.mcp.json` (Postgres, context7) para a config de MCP do Antigravity. Verifique que o agente lista as skills `research`, `plan-context`, `plan-validate`, `plan-resolve`, `plan-build` e `implement` e consegue consultar o context7.

## 2. Research e pipeline de planejamento (artefatos da fase)

- [x] 2.1 Rode a etapa `research` e escreva `repo/docs/decisions/technical-decisions-phase-03-videos.md` no formato dos TDs existentes (frontmatter, `TD-0x`, opções, prós e contras, recomendação, `Capability:`). Precisa ter TDs de fila (BullMQ + Redis contra RabbitMQ, SQS e pg-boss), estratégia de upload (multipart pré-assinado), organização do storage e host público (D3/D4), worker e FFmpeg (D5/D6), URL única (D8), streaming e download (D9) e ciclo de status com retries (D7). Verifique que cada bullet da Fase 03 em `docs/project-plan.md` está coberto por algum TD.
- [x] 2.2 Rode `plan-context` e gere `repo/docs/phases/phase-03-videos/context.md` no formato de `phase-02-auth/context.md`: Scope, Decisions Index, Capability Coverage, Decisions Detail, Inherited Decisions/Conventions. Verifique que todas as capabilities da fase aparecem como cobertas.
- [x] 2.3 Rode `plan-validate` e gere `validation.md`. Itere `plan-resolve` ↔ `plan-validate` até ter frontmatter com `status: clean` e `issue_count: 0`. Verifique pelo frontmatter.
- [x] 2.4 No `plan-resolve`, fixe as libs com context7 e gere `library-refs.md` com `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`, `bullmq` e `@nestjs/bullmq` (versões, APIs usadas e armadilhas, como `forcePathStyle`, presign de `UploadPart`, `WorkerHost` e `UnrecoverableError`). Verifique que cada lib tem versão fixada compatível com NestJS 11.
- [x] 2.5 Rode `plan-build` e gere `phase-03-videos.md` com SIs `SI-03.x` alinhados aos grupos 3–8 abaixo, Technical Specifications (Data Model = D13, API Contracts, Authorization Matrix, Error Catalog, Events/Messages = D14), Dependency Map e Deliverables. Verifique que todos os cenários de `specs/videos/*` estão em algum critério de aceite de SI. Crie `progress.md` com todos os SIs em `pending`.

## 3. Infraestrutura: Compose, imagem e configuração

- [x] 3.1 Adicione `ffmpeg` ao `apt install` do `Dockerfile.dev` e rode `docker compose build`. Verifique com `docker compose exec nestjs-api ffprobe -version`.
- [x] 3.2 Adicione ao `compose.yaml`:
  - `redis` (`redis:7-alpine`, `--maxmemory-policy noeviction --appendonly yes`, healthcheck `redis-cli ping`);
  - `minio` (`minio/minio`, `server /data --console-address :9001`, portas 9000/9001, volume, healthcheck);
  - `minio-init` (`minio/mc`, cria `streamtube-media` com `--ignore-existing`);
  - `depends_on` do `nestjs-api` nesses serviços.

  Verifique com `docker compose up -d`, `docker compose ps`, `docker compose exec redis redis-cli ping` (`PONG`) e o bucket listado via `mc ls`.
- [x] 3.3 Instale `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`, `bullmq` e `@nestjs/bullmq` nas versões de `library-refs.md`. Verifique com `npm ls` e `npx tsc --noEmit`.
- [x] 3.4 Crie `src/config/storage.config.ts`, `queue.config.ts` e `upload.config.ts` (D12). Registre-os no `ConfigModule.forRoot({ load })`, estenda `env.validation.ts` e atualize `.env.example` e `.env` com hosts `minio`/`redis` e `S3_PUBLIC_ENDPOINT=http://localhost:9000`. Verifique com um caso novo em `env.validation.integration-spec.ts` (credenciais S3 ausentes falham o bootstrap) e `GET /` continuando `200`.
- [x] 3.5 Atualize `nestjs-project/CLAUDE.md` e o `GEMINI.md` equivalente: serviços `redis`, `minio` (console 9001) e `minio-init`, checagens de prontidão (`redis-cli ping`, `mc ls`), necessidade de `docker compose build` e a regra do `S3_PUBLIC_ENDPOINT`. Verifique que todo comando documentado roda como está escrito. Marque o SI correspondente em `progress.md`.

## 4. Módulo de storage (S3/MinIO)

- [x] 4.1 Implemente `src/storage/storage.module.ts` e `storage.service.ts`, com cliente interno e cliente de assinatura pública (D3):
  - `createMultipartUpload`;
  - `presignUploadParts`;
  - `completeMultipartUpload`;
  - `headObject`;
  - `putObject`;
  - `deleteObject`;
  - `presignGetObject` (com `ResponseContentType` e `ResponseContentDisposition` opcionais);
  - `presignInternalGetObject`.

  Verifique com `storage.module.spec.ts` (o módulo compila).
- [x] 4.2 Escreva `storage.service.integration-spec.ts` contra o MinIO real: multipart de 2 partes (5 MiB + 1 MiB) com `PUT` nas URLs pré-assinadas, `complete`, `head` com o tamanho certo, presign GET com `Range` respondendo `206`, `Content-Disposition` aplicado, `delete`. Verifique que o teste passa com `--runInBand`.

## 5. Entidade `Video` e migration

- [x] 5.1 Crie `src/videos/entities/video.entity.ts` conforme D13: enum `VideoStatus`, transformers para `size_bytes` e `duration_seconds`, `@ManyToOne(() => Channel)` com `channel_id`. Registre em `TypeOrmModule.forFeature([Video])` no `VideosModule` (esqueleto) e importe `VideosModule` no `AppModule`.
- [x] 5.2 Gere `src/database/migrations/<ts>-CreateVideos.ts` com `npm run migration:generate` e revise o SQL: enum `video_status`, unique `slug`, índices `channel_id` e `status`, FK com `ON DELETE CASCADE`. Inclua `videos` em `cleanAllTables` (primeiro na ordem) e no `migrations.integration-spec.ts` (apply/revert). Verifique com `npm run migration:run`, `migration:revert` e `migration:run` sem erro.
- [x] 5.3 Escreva `video.entity.integration-spec.ts`: slug duplicado rejeitado, enum rejeita valor inválido, `size_bytes` de 10 GiB volta como `number` exato, `duration_seconds` como `number`, cascade ao remover o canal. Verifique que o teste passa.

## 6. Upload: pré-cadastro, URLs de parte e conclusão com enfileiramento

- [x] 6.1 Adicione `ChannelsService.findByUserId`, com testes unit e de integração em `channels.service.*spec.ts`. Crie `src/videos/slug.util.ts` (11 caracteres base64url) com `slug.util.spec.ts` validando o formato `^[A-Za-z0-9_-]{11}$`.
- [x] 6.2 Crie as exceções de domínio (`VIDEO_NOT_FOUND` 404, `VIDEO_UPLOAD_NOT_IN_PROGRESS` 409, `INVALID_UPLOAD_PARTS` 400, `UPLOAD_SIZE_MISMATCH` 422) estendendo `DomainException`. Crie os DTOs `CreateVideoDto` (filename 1..255, `size_bytes` int 1..`UPLOAD_MAX_SIZE_BYTES`, `mime_type` na allowlist, `title?` 1..100), `PresignPartsDto` (`part_numbers` int ≥1, 1..100 itens, únicos) e `CompleteUploadDto` (`parts[{part_number, etag}]`). Verifique com unit tests do `ValidationPipe` (10737418241 e `image/png` dão `400 VALIDATION_ERROR`).
- [x] 6.3 Implemente `VideosService.initiateUpload`: canal do usuário, slug com retry de colisão, título derivado, `storage_key = videos/{id}/source`, `CreateMultipartUpload`, `part_count`, URLs pré-assinadas. Implemente também `presignParts` (só dono, só `draft`, intervalo válido). Verifique com `videos.service.spec.ts` (cálculo de partes para 1 B, 64 MiB e 10 GiB; título derivado; colisão de slug; `404` para não dono; `409` fora de `draft`).
- [x] 6.4 Implemente `VideosService.completeUpload` (D7): validação das partes (completas e sem repetição); `CompleteMultipartUpload` com erro do S3 virando `INVALID_UPLOAD_PARTS`; `HeadObject` com tamanho divergente levando a `failed`, delete do objeto e `422`; transação condicional `draft → processing` mais `queue.add('process-video', { videoId }, { jobId: videoId, attempts: 3, backoff exponencial 5s })` com rollback se o `add` falhar. Verifique com unit tests de cada ramo e com `videos.service.integration-spec.ts` (MinIO, Redis e Postgres reais: o job existe na fila com `jobId = videoId` e complete repetido dá `409` sem novo job).
- [x] 6.5 Implemente `VideosController` (`POST /videos` 201, `POST /videos/:slug/upload/parts` 200, `POST /videos/:slug/upload/complete` 202) com Swagger e `@Throttle` (D11). Verifique com `test/videos.e2e-spec.ts` (parte de upload): `401` sem token; início válido; `PUT` das partes no MinIO; `complete` com `202`; `400` para partes inválidas; `404` para não dono; `409` para repetição. Regenere `openapi.json` (`npm run openapi:export`) e confira que `openapi-export.integration-spec.ts` passa. Atualize `progress.md`.

## 7. Worker de vídeo (fila, ffprobe e thumbnail)

- [x] 7.1 Implemente `src/video-worker/ffmpeg.service.ts` (D6): `probe(url)` e `extractFrame(url, t)` via `spawn`, com timeout e erro tipado, e um parser `ffprobe → { duration_seconds, metadata }`. Verifique com `ffprobe-parser.spec.ts` (com e sem áudio, sem stream de vídeo) e `ffmpeg.service.integration-spec.ts` usando um fixture gerado com `ffmpeg -f lavfi` (duração ≈2s, 320x240, JPEG válido com largura ≤1280).
- [x] 7.2 Implemente `video.processor.ts` (`@Processor('video-processing')`, `WorkerHost`, `concurrency` vindo da config):
  - encerra sem efeito se o vídeo não estiver em `processing`;
  - faz probe via URL pré-assinada interna;
  - extrai a thumbnail no instante `min(1, 10% da duração)`;
  - faz `putObject` de `videos/{id}/thumbnail.jpg`;
  - aplica `UPDATE ... WHERE status='processing'` para `ready`;
  - lança `UnrecoverableError` quando não há stream de vídeo;
  - no handler `failed` final (ou não recuperável), marca `failed` com `failure_reason` (máx. 500).

  Verifique com `video.processor.spec.ts` (todos os ramos) e `video.processor.integration-spec.ts` (vídeo válido termina `ready` com metadados e thumbnail no MinIO; arquivo não vídeo termina `failed` sem retry; job reentregue para vídeo `ready` não muda nada).
- [x] 7.3 Crie `src/video-worker/worker.module.ts` e `src/worker.ts` (`createApplicationContext`, shutdown hooks) e o script `start:worker:dev` (`nest start --watch --entryFile worker`) mais `start:worker:prod`. Adicione ao Compose o serviço `video-worker` (mesmo build e volume, `restart: unless-stopped`, `depends_on` em db, redis e minio-init). Verifique com `docker compose up -d video-worker` e `docker compose logs video-worker` mostrando o worker conectado à fila `video-processing`.
- [x] 7.4 Documente o worker no `nestjs-project/CLAUDE.md`/`GEMINI.md`: serviço, scripts, logs, ordem `npm install` → worker e como reprocessar. Verifique os comandos documentados e atualize `progress.md`.

## 8. Entrega: URL única, metadados, streaming, download e thumbnail

- [x] 8.1 Altere `JwtAuthGuard` para autenticação opcional em rotas `@Public()` (D10) e ajuste a tipagem de `@CurrentUser()`. Verifique com `jwt-auth.guard.spec.ts` (rota pública: token válido popula `user`, token inválido segue anônimo; rota protegida continua com `401`) e com a suíte `auth.e2e-spec.ts` continuando verde.
- [x] 8.2 Implemente `VideosService.findBySlugForViewer`, com visibilidade por status e dono e o DTO de resposta da spec (URLs só quando `ready`, `failure_reason` só para o dono), e os resolvers de redirect para stream, download (`attachment; filename` mais `filename*`) e thumbnail. Verifique com unit tests de cada combinação anônimo/dono/não dono × status.
- [x] 8.3 Adicione ao controller `GET /videos/:slug`, `/stream`, `/download` e `/thumbnail` (`@Public()`, `302` via `@Redirect`/`res.redirect`, `@SkipThrottle()` nos redirects) com Swagger. Verifique com `test/videos.e2e-spec.ts` (fluxo completo):
  - upload, `complete` e processor rodando no teste até `ready`;
  - `GET` anônimo `200`;
  - `/stream` seguido com `Range: bytes=0-1023` responde `206` com `Content-Range` e 1024 bytes;
  - `/download` com `Content-Disposition: attachment; filename="..."`;
  - `/thumbnail` com `image/jpeg`;
  - vídeo `processing` dá `404` para anônimo e não dono e `200` para o dono;
  - token inválido em rota pública dá `200`;
  - URL expirada (TTL curto via env no teste) dá `403`.

  Regenere `openapi.json` e atualize `progress.md`.

## 9. Documentação final e fechamento da fase

- [x] 9.1 Atualize o `CLAUDE.md` raiz e o `GEMINI.md`/`AGENTS.md` equivalente: Message Queue = Redis/BullMQ (sem "TBD"), seção **Videos** com módulo, endpoints, fila e job, worker e storage, apontando para `docs/phases/phase-03-videos/`. Atualize `docs/diagrams/software-arch.mermaid` (fila "Redis (BullMQ)"). Verifique que todo arquivo, endpoint e comando citado existe no código (`grep` de cada caminho e rota citados).
- [x] 9.2 Rode a Definition of Done completa no container: `npm test -- --runInBand`, `npm run test:e2e`, `npx tsc --noEmit` (exit 0), `npm run lint` e `npm run build`. Verifique que todos passam e registre a contagem de testes por SI em `progress.md` com `Status: completed`.
- [x] 9.3 Faça a checagem de sistema com stack limpa: `docker compose down -v`, `build`, `up -d`, `migration:run` e um upload manual de vídeo real (por exemplo, via `api.http` mais `curl` para as partes). Confirme `ready`, reprodução do `/stream` no navegador com seek funcionando e download. Revise os Critérios de Aceite do `streamtube.md` item a item no `progress.md`.
- [x] 9.4 Faça commits curtos por SI na `feature/phase-03-videos`, push para o fork e abra PR para `dev`, sem commit direto na `main`. Verifique com `git log --oneline dev..feature/phase-03-videos` e o PR aberto contra `dev`.
