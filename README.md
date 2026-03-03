# Media Capture Starter (MV3)

Extensao Chrome (Manifest V3) para detectar e baixar midias com fila de jobs e logs estruturados.

## Funcionalidades

- Scan de midia na aba ativa (`video`, `audio`, `source`).
- Catalogo compartilhado entre abas (persistido).
- Fila de downloads com estados:
  - `queued`
  - `downloading`
  - `completed`
  - `failed`
  - `cancelled`
- Cancelamento de job em andamento.
- Limpeza de historico por tipo (`completed`, `failed/cancelled`, `all terminal`).
- Retencao configuravel dos jobs (dias).
- Seletor manual de plano com apenas duas opcoes:
  - `premium`
  - `enterprise`
- Relatorio de falha copiavel em JSON.

## Arquitetura

- `manifest.json`
  - Permissoes: `storage`, `downloads`, `tabs`, `scripting`.
  - `service_worker` em `src/background/service-worker.js`.
  - Content script global em `src/content/detector.js`.
- `src/background/service-worker.js`
  - Orquestra fila, estados, persistencia, limpeza e logs.
  - Download HTTP normal feito na extensao (`extension`).
  - Download `blob:` feito na extensao por transferencia em chunks via `Port` (`extension-blob`).
- `src/content/detector.js`
  - Detecta midias no DOM.
  - Responde scan.
  - Faz stream de `blob:` para o worker por `chrome.runtime.connect`.
- `src/popup/*`
  - UI de scan, fila, limpeza, retencao e planos.
- `src/shared/*`
  - Contratos de mensagens e plano.

## Fluxo de Download

### 1) URL normal (`http/https`)

1. Worker faz `fetch`.
2. Bufferiza em memoria.
3. Converte para `data:` URL.
4. Salva com `chrome.downloads.download`.

### 2) URL `blob:`

1. Worker identifica que e `blob:`.
2. Faz rescan da aba para atualizar blob quando necessario.
3. Abre um `Port` com o content script.
4. Content script faz `fetch(blob)` e envia `BLOB_META` + `BLOB_CHUNK`.
5. Worker remonta o arquivo, converte para `data:` URL e salva com `chrome.downloads.download`.

## Logs e Diagnostico

- Falhas ficam nos campos:
  - `errorStage`
  - `errorCode`
  - `errorMessage`
- Console do worker:
  - prefixo: `[MediaCapture][JobFailed]`
  - payload em JSON string (nao `[object Object]`)

## Persistencia (`chrome.storage.local`)

- `download_jobs`
- `media_catalog`
- `job_retention_days`
- `plan`

## Rodar Local

1. Abra `chrome://extensions`.
2. Ative `Developer mode`.
3. Clique em `Load unpacked`.
4. Selecione a pasta `extension-starter`.

## Desenvolvimento

- Verificacao rapida de sintaxe:

```bash
node --check src/background/service-worker.js
node --check src/content/detector.js
node --check src/popup/popup.js
```

## Limites conhecidos

- Fluxo atual bufferiza arquivo em memoria antes de salvar.
- Arquivos muito grandes podem exigir streaming para `FileSystem Access API` em etapa futura.
