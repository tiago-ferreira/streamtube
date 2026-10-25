# videos/video-processing Specification

## Purpose
Processa vídeos enviados de forma automática e assíncrona, fora do processo da API. Extrai duração e metadados, gera uma thumbnail e mantém o status do vídeo coerente até ele ficar pronto ou falhar.

## Requirements

### Requirement: Processamento assíncrono automático
O sistema SHALL processar cada vídeo em um worker separado da API, consumindo o job publicado na conclusão do upload, sem nenhuma ação extra do usuário. A resposta da API na conclusão do upload MUST NOT esperar o processamento terminar.

#### Scenario: Vídeo processado após o upload
- **WHEN** o upload de um vídeo válido é concluído e o vídeo passa para `processing`
- **THEN** o worker consome o job e, ao terminar, o vídeo fica com status `ready` no banco

#### Scenario: Conclusão do upload não espera o processamento
- **WHEN** o dono conclui o upload
- **THEN** a API responde `202` assim que o job é enfileirado, com o vídeo ainda em `processing`

### Requirement: Extração de duração e metadados
O sistema SHALL extrair do arquivo enviado e guardar no vídeo a duração em segundos e os metadados técnicos: largura, altura, codec de vídeo, codec de áudio (ou nulo se não houver áudio), formato do contêiner, bitrate e taxa de quadros.

#### Scenario: Metadados de um vídeo com áudio
- **WHEN** o worker processa um MP4 de 2 segundos, 320x240, com faixa de áudio
- **THEN** o vídeo fica com duração de aproximadamente `2` segundos, `width: 320`, `height: 240` e codecs de vídeo e áudio preenchidos

#### Scenario: Vídeo sem faixa de áudio
- **WHEN** o worker processa um vídeo válido sem faixa de áudio
- **THEN** o vídeo fica `ready` com codec de áudio nulo nos metadados

### Requirement: Geração automática de thumbnail
O sistema SHALL gerar uma imagem JPEG a partir de um frame do vídeo, no instante `min(1s, 10% da duração)`, com largura máxima de 1280 px e proporção preservada. A imagem SHALL ser guardada no object storage e associada ao vídeo.

#### Scenario: Thumbnail gerada
- **WHEN** o worker processa um vídeo válido
- **THEN** existe no storage um objeto JPEG de thumbnail associado ao vídeo, e o vídeo pronto tem referência a ela

### Requirement: Ciclo de status do vídeo
O status do vídeo SHALL seguir apenas as transições `draft → processing`, `draft → failed`, `processing → ready` e `processing → failed`, sempre refletidas no banco. `ready` e `failed` são estados finais nesta fase.

#### Scenario: Vídeo pronto registra o fim do processamento
- **WHEN** o processamento termina com sucesso
- **THEN** o vídeo fica com `status: "ready"`, duração, metadados, thumbnail e data de processamento preenchidos

#### Scenario: Transição inválida ignorada
- **WHEN** um job de processamento é entregue para um vídeo cujo status não é `processing`
- **THEN** o worker não altera o vídeo e encerra o job sem erro

### Requirement: Tratamento de falhas no processamento
O sistema SHALL tentar de novo, com backoff exponencial e até 3 tentativas no total, as falhas transitórias de processamento. Arquivos sem faixa de vídeo legível SHALL falhar sem nova tentativa. Ao falhar de vez, o vídeo SHALL passar para `failed` com o motivo registrado.

#### Scenario: Arquivo que não é um vídeo válido
- **WHEN** o worker processa um objeto que não contém faixa de vídeo legível
- **THEN** o vídeo passa para `failed`, com um `failure_reason` que descreve o problema, sem novas tentativas e sem thumbnail

#### Scenario: Falha transitória recuperada
- **WHEN** a primeira tentativa de processamento falha por indisponibilidade momentânea do storage e a segunda tentativa tem sucesso
- **THEN** o vídeo termina com `status: "ready"`

#### Scenario: Tentativas esgotadas
- **WHEN** as 3 tentativas de processamento falham
- **THEN** o vídeo fica com `status: "failed"` e `failure_reason` preenchido

### Requirement: Idempotência do processamento
O sistema SHALL garantir no máximo um job de processamento ativo por vídeo. Jobs repetidos ou entregues de novo MUST NOT duplicar a thumbnail nem sobrescrever um vídeo já `ready`.

#### Scenario: Job reentregue para vídeo pronto
- **WHEN** um job de processamento é entregue de novo para um vídeo que já está `ready`
- **THEN** o vídeo continua com os mesmos dados e o job é encerrado sem erro

### Requirement: Infraestrutura de processamento sobe com a stack
O object storage, a fila e o worker de vídeo SHALL subir com o comando padrão de Compose do backend. O worker SHALL se conectar à fila, ao banco e ao storage pelos nomes de serviço da rede Docker.

#### Scenario: Stack completa no Compose
- **WHEN** o desenvolvedor executa `docker compose up -d` em `nestjs-project/`
- **THEN** os serviços de API, banco, mail, object storage, fila e worker ficam em execução e o bucket de mídia existe
