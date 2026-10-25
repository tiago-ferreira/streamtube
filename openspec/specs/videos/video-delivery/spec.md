# videos/video-delivery Specification

## Purpose
Dá a cada vídeo uma URL única e estável e expõe seus metadados, a reprodução por streaming (sem download completo), o download do arquivo original e a thumbnail. Usuários anônimos acessam vídeos prontos; o dono também enxerga os próprios vídeos ainda não prontos.

## Requirements

### Requirement: URL única por vídeo
O sistema SHALL dar a cada vídeo, na criação, um `slug` de 11 caracteres do alfabeto `[A-Za-z0-9_-]`, gerado aleatoriamente, único entre todos os vídeos e imutável. O `slug` SHALL identificar o vídeo em todas as rotas `/videos/{slug}`.

#### Scenario: Slug gerado no pré-cadastro
- **WHEN** um vídeo é criado ao iniciar um upload
- **THEN** a resposta traz um `slug` de 11 caracteres que bate com `^[A-Za-z0-9_-]{11}$`

#### Scenario: Colisão de slug
- **WHEN** o slug sorteado já pertence a outro vídeo
- **THEN** o sistema sorteia outro slug e cria o vídeo sem erro para o usuário, e os dois vídeos ficam com slugs diferentes

#### Scenario: Muitos vídeos sem conflito
- **WHEN** vários vídeos são criados, inclusive em paralelo
- **THEN** todos têm slugs distintos, garantidos por uma restrição de unicidade no banco

### Requirement: Consulta de metadados do vídeo
O sistema SHALL devolver em `GET /videos/{slug}`: `id`, `slug`, `title`, `status`, `original_filename`, `mime_type`, `size_bytes`, `duration_seconds`, `metadata`, `channel` (`id`, `nickname`, `name`), `created_at` e `processed_at`. A resposta SHALL incluir `stream_url`, `download_url` e `thumbnail_url` (caminhos da API) apenas quando o vídeo estiver `ready`.

#### Scenario: Vídeo pronto consultado anonimamente
- **WHEN** um cliente sem autenticação envia `GET /videos/{slug}` de um vídeo `ready`
- **THEN** o sistema responde `200` com os metadados, `duration_seconds` preenchido e `stream_url`, `download_url` e `thumbnail_url` presentes

#### Scenario: Slug inexistente
- **WHEN** um cliente envia `GET /videos/{slug}` com um slug que não existe
- **THEN** o sistema responde `404` com `error: "VIDEO_NOT_FOUND"`

### Requirement: Visibilidade de vídeos não prontos
Vídeos em `draft`, `processing` ou `failed` SHALL ser visíveis em `GET /videos/{slug}` apenas para o dono autenticado, com o status atual e, se `failed`, o `failure_reason`. Para os demais SHALL responder como inexistentes.

#### Scenario: Dono acompanha o processamento
- **WHEN** o dono autenticado envia `GET /videos/{slug}` de um vídeo em `processing`
- **THEN** o sistema responde `200` com `status: "processing"` e sem `stream_url`, `download_url` nem `thumbnail_url`

#### Scenario: Dono vê o motivo da falha
- **WHEN** o dono autenticado consulta um vídeo `failed`
- **THEN** a resposta traz `status: "failed"` e `failure_reason`

#### Scenario: Anônimo ou outro usuário consulta vídeo não pronto
- **WHEN** um cliente anônimo, ou um usuário autenticado que não é dono, envia `GET /videos/{slug}` de um vídeo que não está `ready`
- **THEN** o sistema responde `404` com `error: "VIDEO_NOT_FOUND"`

### Requirement: Autenticação opcional em rotas públicas
Rotas públicas SHALL reconhecer o usuário quando houver um token de acesso válido. Se o token for inválido ou estiver expirado, a requisição SHALL seguir como anônima, sem `401`. Rotas protegidas SHALL continuar exigindo um token válido.

#### Scenario: Token inválido em rota pública
- **WHEN** um cliente envia `GET /videos/{slug}` de um vídeo `ready` com um Bearer token inválido
- **THEN** o sistema responde `200`, tratando a requisição como anônima

#### Scenario: Rota protegida continua protegida
- **WHEN** um cliente envia `POST /videos` com um Bearer token inválido
- **THEN** o sistema responde `401`

### Requirement: Reprodução via streaming
`GET /videos/{slug}/stream` SHALL responder com redirecionamento `302` para uma URL temporária do arquivo no object storage. Essa URL SHALL aceitar requisições com `Range` e responder `206 Partial Content`, para que a reprodução comece sem baixar o arquivo inteiro.

#### Scenario: Requisição parcial
- **WHEN** um cliente segue o redirecionamento de `GET /videos/{slug}/stream` de um vídeo `ready` enviando `Range: bytes=0-1023`
- **THEN** o storage responde `206` com `Content-Range: bytes 0-1023/<size_bytes>`, exatamente 1024 bytes e `Content-Type` igual ao `mime_type` do vídeo

#### Scenario: Stream de vídeo não pronto
- **WHEN** um cliente envia `GET /videos/{slug}/stream` de um vídeo que não está `ready` ou que não existe
- **THEN** o sistema responde `404` com `error: "VIDEO_NOT_FOUND"`

### Requirement: Download do vídeo
`GET /videos/{slug}/download` SHALL responder com redirecionamento `302` para uma URL temporária que entrega o arquivo original com `Content-Disposition: attachment` e o nome original do arquivo.

#### Scenario: Download de vídeo pronto
- **WHEN** um cliente segue o redirecionamento de `GET /videos/{slug}/download` de um vídeo `ready` com `original_filename: "aula.mp4"`
- **THEN** o storage responde `200` com o arquivo completo e `Content-Disposition` contendo `attachment` e `filename="aula.mp4"`

#### Scenario: Download de vídeo não pronto
- **WHEN** um cliente envia `GET /videos/{slug}/download` de um vídeo que não está `ready`
- **THEN** o sistema responde `404` com `error: "VIDEO_NOT_FOUND"`

### Requirement: Acesso à thumbnail
`GET /videos/{slug}/thumbnail` SHALL responder com redirecionamento `302` para uma URL temporária da imagem JPEG do vídeo `ready`. Se o vídeo não estiver pronto ou não tiver thumbnail, SHALL responder `404` com `error: "VIDEO_NOT_FOUND"`.

#### Scenario: Thumbnail de vídeo pronto
- **WHEN** um cliente segue o redirecionamento de `GET /videos/{slug}/thumbnail` de um vídeo `ready`
- **THEN** o storage responde `200` com `Content-Type: image/jpeg`

### Requirement: Expiração das URLs temporárias
As URLs temporárias de stream, download, thumbnail e upload de partes SHALL expirar após um tempo configurável. Depois disso, o storage MUST recusar o acesso.

#### Scenario: URL expirada
- **WHEN** um cliente usa uma URL temporária depois do tempo de expiração
- **THEN** o storage recusa a requisição com `403`, e o cliente precisa pedir uma nova URL à API
