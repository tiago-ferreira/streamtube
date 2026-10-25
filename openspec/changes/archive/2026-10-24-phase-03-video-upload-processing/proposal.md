# Proposal

## Why

O StreamTube já tem as Fases 01 (base) e 02 (auth, usuários e canais) fechadas, mas ainda não armazena nem processa vídeos, que são o centro do produto. A Fase 03 (`docs/project-plan.md`) é a dependência direta das Fases 04 e 05. Ela exige upload de até 10GB sem travar a API, processamento assíncrono (metadados e thumbnail), URL única, streaming e download. Para isso, a stack precisa de três componentes que hoje não existem: object storage (S3/MinIO), fila e worker de vídeo (FFmpeg). Eles já aparecem em `docs/diagrams/software-arch.mermaid`. A fila ainda está como "TBD".

## What Changes

- **Infraestrutura nova no `nestjs-project/compose.yaml`**: `minio` (object storage compatível com S3) com bootstrap do bucket, `redis` (backend da fila) e `video-worker` (processo Node separado com FFmpeg/ffprobe). Todos sobem com `docker compose up -d` junto com `nestjs-api`, `db` e `mailpit`.
- **Decisão da fila: BullMQ + Redis** (`@nestjs/bullmq`). A decisão é registrada com alternativas e trade-offs em `docs/decisions/technical-decisions-phase-03-videos.md`.
- **Novo módulo `videos/` no backend**, com entidade e tabela `videos` ligada a `channels` (N:1), migration versionada e ciclo de status `draft → processing → ready | failed`.
- **Upload direto ao storage**: S3 Multipart Upload com URLs pré-assinadas por parte. O arquivo **nunca passa pela API**. Ao iniciar o upload, o vídeo é pré-cadastrado como rascunho (`draft`).
- **Conclusão do upload** (`complete`): valida as partes e o tamanho, muda o vídeo para `processing` e publica o job `process-video` na fila.
- **Worker de vídeo**: consome o job, extrai duração e metadados com `ffprobe`, gera a thumbnail a partir de um frame com `ffmpeg`, grava no storage e marca o vídeo como `ready`. Se der erro, aplica retry com backoff e, ao esgotar as tentativas, marca `failed` com o motivo.
- **URL única** por vídeo: `slug` aleatório de 11 caracteres (base64url), com constraint única e retry em caso de colisão.
- **Streaming e download**: endpoints públicos redirecionam (`302`) para URLs pré-assinadas do storage. O storage responde a requisições `Range` com `206 Partial Content`. O download usa `Content-Disposition: attachment`.
- **Autenticação opcional em rotas públicas**: o `JwtAuthGuard` passa a popular `request.user` quando uma rota `@Public()` recebe um Bearer válido. Isso permite que o dono veja os próprios vídeos ainda não prontos. Rotas protegidas não mudam.
- **Artefatos do workflow do projeto** em `docs/phases/phase-03-videos/` (`context.md`, `validation.md` em `clean`, `library-refs.md`, `phase-03-videos.md` com `SI-03.x` e Technical Specifications incluindo Events/Messages, `progress.md`), além da atualização do `CLAUDE.md` e dos equivalentes da ferramenta de IA em uso.

## Capabilities

### New Capabilities

- `videos/video-upload`: pré-cadastro do vídeo como rascunho, sessão de upload multipart direto ao storage (URLs pré-assinadas, renovação de URLs), limite de 10GB, tipos aceitos e conclusão do upload com enfileiramento do processamento.
- `videos/video-processing`: consumo assíncrono do job pelo worker, extração de duração e metadados, geração de thumbnail, ciclo de status (`draft → processing → ready | failed`), retries e idempotência.
- `videos/video-delivery`: identificação do vídeo por URL única (`slug`), consulta de metadados, streaming com suporte a `Range`, download e acesso à thumbnail, com regras de visibilidade por status e por dono.

### Modified Capabilities

_Nenhuma._ Ainda não há specs em `openspec/specs/`. O ajuste de autenticação opcional no `JwtAuthGuard` é coberto pelos requisitos de `videos/video-delivery`.

## Impact

- **Código (`mba-ia-greenfield-project/nestjs-project/`)**:
  - novos `src/videos/` (módulo, controller, service, entidade, DTOs, exceções), `src/storage/` (cliente S3 e presigner) e `src/video-worker/` (módulo do worker, processor e wrapper de FFmpeg);
  - novos `src/worker.ts` (entrypoint do worker) e `src/config/storage.config.ts` e `queue.config.ts`;
  - nova migration `CreateVideos`;
  - alterações em `src/auth/guards/jwt-auth.guard.ts` (auth opcional), `ChannelsService` (`findByUserId`), `env.validation.ts`, `.env.example`, `app.module.ts`, `test/create-test-data-source.ts` (limpeza de `videos`) e `Dockerfile.dev` (instalação do `ffmpeg`).
- **API nova**:
  - `POST /videos`, `POST /videos/:slug/upload/parts` e `POST /videos/:slug/upload/complete` (autenticados);
  - `GET /videos/:slug`, `GET /videos/:slug/stream`, `GET /videos/:slug/download` e `GET /videos/:slug/thumbnail` (públicos).
- **Dependências novas**: `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`, `bullmq` e `@nestjs/bullmq`. Também o binário `ffmpeg`/`ffprobe` na imagem Docker.
- **Infra**: serviços `minio`, `minio-init`, `redis` e `video-worker` no Compose. Novas variáveis `S3_*`, `REDIS_*`, `UPLOAD_*` e `VIDEO_WORKER_*`.
- **Docs**: `docs/decisions/technical-decisions-phase-03-videos.md`, pasta `docs/phases/phase-03-videos/`, `CLAUDE.md` raiz e `nestjs-project/CLAUDE.md` (seção de vídeos, serviços e comandos do worker), `docs/diagrams/software-arch.mermaid` (fila deixa de ser "TBD").
- **Fora de escopo**: interface de vídeo no `next-frontend/`, edição, publicação e visibilidade (Fase 04), transcodificação/HLS, contagem de views (Fase 05) e exclusão de vídeos.
