# Spec Delta

## Purpose

Permite que o dono de um canal envie arquivos de vídeo de até 10GB direto para o object storage, sem que o arquivo passe pela API. O vídeo é pré-cadastrado como rascunho ao iniciar o envio e entra na fila de processamento quando o envio termina.

## ADDED Requirements

### Requirement: Iniciar upload pré-cadastra o vídeo como rascunho
O sistema SHALL permitir que um usuário autenticado inicie o upload de um vídeo informando nome do arquivo, tamanho em bytes, tipo MIME e, opcionalmente, um título. A chamada SHALL criar o vídeo no canal do usuário com status `draft` e devolver a sessão de upload multipart: tamanho de parte, quantidade de partes e uma URL temporária de envio para cada parte.

#### Scenario: Início de upload válido
- **WHEN** um usuário autenticado envia `POST /videos` com `filename: "aula.mp4"`, `size_bytes: 157286400`, `mime_type: "video/mp4"` e `title: "Aula 1"`
- **THEN** o sistema responde `201` com `id`, `slug`, `title: "Aula 1"` e `status: "draft"`
- **AND** a resposta traz `upload.part_size`, `upload.part_count` igual a `ceil(size_bytes / part_size)`, `upload.expires_at` e `upload.parts` com um par `{ part_number, url }` para cada parte de `1` a `part_count`
- **AND** existe um registro em `videos` ligado ao canal do usuário com status `draft`

#### Scenario: Título derivado do nome do arquivo
- **WHEN** um usuário autenticado inicia um upload sem `title` e com `filename: "minha-viagem.mov"`
- **THEN** o vídeo é criado com `title: "minha-viagem"` (nome do arquivo sem extensão, truncado em 100 caracteres)

#### Scenario: Requisição sem autenticação
- **WHEN** um cliente sem token de acesso válido envia `POST /videos`
- **THEN** o sistema responde `401` e nenhum vídeo é criado

### Requirement: Limite de tamanho de 10GB
O sistema SHALL aceitar arquivos de 1 byte até 10 GiB (10737418240 bytes) e SHALL rejeitar, antes de criar qualquer registro, pedidos de upload com tamanho fora desse intervalo.

#### Scenario: Arquivo de exatamente 10 GiB
- **WHEN** um usuário autenticado inicia um upload com `size_bytes: 10737418240`
- **THEN** o sistema responde `201`, com `part_count` dentro do limite de partes suportado pelo storage

#### Scenario: Arquivo acima de 10 GiB
- **WHEN** um usuário autenticado inicia um upload com `size_bytes: 10737418241`
- **THEN** o sistema responde `400` com `error: "VALIDATION_ERROR"` e nenhum vídeo é criado

### Requirement: Tipos de arquivo aceitos
O sistema SHALL aceitar apenas os tipos MIME `video/mp4`, `video/webm`, `video/quicktime` e `video/x-matroska` ao iniciar um upload.

#### Scenario: Tipo MIME não suportado
- **WHEN** um usuário autenticado inicia um upload com `mime_type: "image/png"`
- **THEN** o sistema responde `400` com `error: "VALIDATION_ERROR"` e nenhum vídeo é criado

### Requirement: Conteúdo do vídeo enviado direto ao storage
O sistema SHALL receber o conteúdo binário do vídeo apenas pelo object storage, através das URLs temporárias de parte. A API MUST NOT receber nem guardar em buffer os bytes do vídeo, para que uploads grandes não ocupem recursos da API.

#### Scenario: Envio das partes direto ao storage
- **WHEN** o cliente envia cada parte com `PUT` para a `url` correspondente devolvida no início do upload
- **THEN** o storage aceita cada parte e devolve um `ETag` por parte, sem nenhuma requisição à API

#### Scenario: API continua responsiva durante upload grande
- **WHEN** um upload multipart está em andamento
- **THEN** outras requisições à API são atendidas normalmente, porque a API não participa da transferência dos bytes

### Requirement: Renovação de URLs de parte
O sistema SHALL permitir que o dono de um vídeo em `draft` peça novas URLs temporárias para até 100 números de parte por requisição, desde que todos estejam entre `1` e `part_count`.

#### Scenario: Renovação válida
- **WHEN** o dono de um vídeo em `draft` envia `POST /videos/{slug}/upload/parts` com `part_numbers: [3, 4]`
- **THEN** o sistema responde `200` com `parts` contendo novas URLs para as partes `3` e `4` e um novo `expires_at`

#### Scenario: Número de parte fora do intervalo
- **WHEN** o dono pede renovação para `part_numbers: [0]` ou para um número maior que `part_count`
- **THEN** o sistema responde `400` com `error: "INVALID_UPLOAD_PARTS"`

#### Scenario: Usuário que não é dono
- **WHEN** um usuário autenticado que não é dono do vídeo pede renovação de partes
- **THEN** o sistema responde `404` com `error: "VIDEO_NOT_FOUND"`

#### Scenario: Vídeo que não está em rascunho
- **WHEN** o dono pede renovação de partes de um vídeo com status `processing`, `ready` ou `failed`
- **THEN** o sistema responde `409` com `error: "VIDEO_UPLOAD_NOT_IN_PROGRESS"`

### Requirement: Conclusão do upload e enfileiramento do processamento
O sistema SHALL permitir que o dono de um vídeo em `draft` conclua o upload enviando a lista completa de partes (`part_number`, `etag`). Quando o objeto final tiver o tamanho declarado, o sistema SHALL mudar o vídeo para `processing`, registrar o momento do upload e enfileirar um único job de processamento.

#### Scenario: Conclusão bem-sucedida
- **WHEN** o dono envia `POST /videos/{slug}/upload/complete` com todas as partes de `1` a `part_count` e os ETags devolvidos pelo storage
- **THEN** o sistema responde `202` com `id`, `slug` e `status: "processing"`
- **AND** o arquivo fica disponível no storage como um único objeto
- **AND** um job de processamento para esse vídeo é publicado na fila

#### Scenario: Lista de partes incompleta ou ETag inválido
- **WHEN** o dono conclui o upload com partes faltando, números repetidos ou um ETag que não bate com o storage
- **THEN** o sistema responde `400` com `error: "INVALID_UPLOAD_PARTS"` e o vídeo continua em `draft`

#### Scenario: Tamanho final diferente do declarado
- **WHEN** o objeto montado no storage tem tamanho diferente de `size_bytes`
- **THEN** o sistema responde `422` com `error: "UPLOAD_SIZE_MISMATCH"`
- **AND** o vídeo passa para `failed`, com motivo registrado, e o objeto enviado é removido do storage

#### Scenario: Conclusão repetida
- **WHEN** o dono envia `POST /videos/{slug}/upload/complete` para um vídeo que já está em `processing`, `ready` ou `failed`
- **THEN** o sistema responde `409` com `error: "VIDEO_UPLOAD_NOT_IN_PROGRESS"` e nenhum job novo é publicado

#### Scenario: Usuário que não é dono tenta concluir
- **WHEN** um usuário autenticado que não é dono do vídeo envia `POST /videos/{slug}/upload/complete`
- **THEN** o sistema responde `404` com `error: "VIDEO_NOT_FOUND"`
