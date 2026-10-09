# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Idioma: o código, os comentários, os logs e a documentação deste repositório são em **português**. Mantenha assim.

## Comandos

```bash
npm install            # sem compilador nativo, sem build step
npm start              # servidor + dashboard em http://localhost:3000
npm test               # 60 verificações de ponta a ponta (~5s), sem Redis e sem API externa
```

Não há linter nem build configurado. `npm test` é a única porta de qualidade — rode antes de qualquer commit.

### Rodando parte do teste

`test.js` é um script sequencial sem framework, numerado em 9 seções (pipeline, paralelo, limpeza, lote, anti-repetição, retry, API+10 vídeos, postar, piloto). Não existe filtro por nome: para isolar uma seção, comente as outras em `main()` ou copie o trecho para um script próprio. Ele usa `DATA_DIR=data/test` e apaga essa pasta no início, então nunca encosta no banco de desenvolvimento.

### Variáveis úteis no desenvolvimento

```bash
SIM_SPEED=0.2 npm start                              # pipeline 5x mais rápido
AGENT_FAIL_RATE=0.3 npm start                        # força falhas: exercita o retry
USE_REDIS=false npm start                            # ignora o Redis de propósito
CONCURRENCY=3 npm start                              # mais vídeos em paralelo (teto de 5)
AUTO_PILOT_IDLE_MS=8000 AUTO_PILOT_CHECK_MS=2000 npm start   # ver o piloto sem esperar 5 min
PORT=3001 npm start                                  # porta 3000 ocupada
```

A lista completa está em `config.js`, que é o **único** lugar que lê `process.env`. Qualquer ajuste novo entra lá, com valor padrão, nunca espalhado pelos módulos.

## Arquitetura

Pipeline de um vídeo (`orchestrator.js:processVideo`):

```
🔍 Pesquisa → ✍️ Roteiro → ┌─ 🎙️ Áudio   ─┐ → 🎬 Edição
                           └─ 🎨 Imagens ─┘   (Promise.all)
```

Quem manda em quê:

- **`config.js`** — toda a configuração e `resolveNicho()`. Nenhum outro módulo lê env var.
- **`agents.js`** — os 5 agentes, mesma assinatura `async (ctx, log) => ({ ...dados })`; cada um devolve um pedaço que o orchestrator mescla em `ctx`. Também tem `publicarYoutube()` e a base de conteúdo (`BASE_CONTEUDO`, 12 tópicos por nicho).
- **`orchestrator.js`** — roda os agentes de um vídeo, reporta progresso por peso de etapa e limpa a pasta temporária no `finally`.
- **`queue.js`** — a fila. Dois drivers, **uma API**: BullMQ+Redis se `REDIS_URL` responder, senão `MemoryQueue` (classe no mesmo arquivo). `runJob()` é o processor comum aos dois; qualquer mudança de comportamento da fila precisa valer para os dois drivers.
- **`store.js`** — persistência JSON (`data/videos.json`), janela de anti-repetição e estatísticas. API sincrona, flush debounced.
- **`autopilot.js`** — o piloto automático: timer de inatividade, travas e middleware do Express.
- **`server.js`** — rotas + `start()`, que devolve `{ app, server, driver }` (o teste usa isso para subir o servidor em processo).

### Três invariantes que não são óbvias

1. **O `store` é a fonte da verdade do progresso, não a fila.** `runJob()` grava `status`/`progresso`/`etapa`/`tentativas` em `store` a cada passo, e o dashboard lê só de lá. É isso que faz o dashboard funcionar igual nos dois drivers. Se precisar de um dado novo na tela, ele tem que passar pelo `store` — não leia estado direto do BullMQ.

2. **`attemptsMade` segue a semântica do BullMQ: tentativas já feitas ANTES desta (0 na primeira).** `MemoryQueue.executar()` incrementa no `catch`, não antes de processar, justamente para bater com isso. Inverter essa ordem faz o console mostrar "tentativa 2/3" na primeira tentativa.

3. **No piloto automático, `GET` não conta como interação — só métodos de ação e downloads** (`autopilot.middleware`). O dashboard faz polling a cada 1,5s; se o polling contasse, o piloto nunca assumiria com a aba aberta.

### Modo simulação

Nenhuma API externa é chamada. Cada agente tem um comentário **`PLUG AQUI`** marcando onde entra a integração real (TTS, geração de imagem, LLM, `ffmpeg`, YouTube Data API). As estruturas de dados já são as finais: trocar a simulação pela API real não deve mexer no pipeline, na fila nem no dashboard. Em `data/output/` os agentes escrevem arquivos de verdade — vídeo placeholder, manifesto JSON com a timeline e thumbnail SVG 1080x1920.

### Dois dashboards diferentes

- `dashboard.html` — o do servidor, consome a API por `fetch`.
- `demo.html` — porte do pipeline inteiro para o navegador, sem backend; é também o artifact publicado. Mudança de comportamento no pipeline que valha para a demo precisa ser refeita à mão lá (os dois não compartilham código de propósito: a demo tem que abrir sem servidor).

## Comportamentos intencionais (não "corrija" sem pensar)

- **Anti-repetição é uma janela de 10, não um bloqueio eterno**: a partir do 11º vídeo do mesmo nicho, um tópico usado há mais de 10 vídeos pode voltar.
- **"Limpar tudo" descarta trabalho em andamento**: os jobs ativos terminam, mas os registros já foram apagados.
- **Vídeos `processing` de um servidor que caiu viram `failed`** no próximo boot (`queue.init`), para o dashboard não mentir.
- **A limpeza de temp no boot só apaga pastas paradas há mais de 5 min**, para não atropelar outra instância usando o mesmo `DATA_DIR`.
- **`quantidade` acima de 100 é cortada em 100** por chamada de `/api/generate-multiple`; a resposta avisa.

## Sessões na nuvem (celular / claude.ai/code)

`.claude/hooks/session-start.sh` roda `npm install` no começo de cada sessão remota, para `npm test` e `npm start` funcionarem num container recém-clonado. Ele sai sem fazer nada quando `CLAUDE_CODE_REMOTE` não é `true`, então no CLI local o `node_modules` continua sendo seu. O hook é síncrono: a sessão só começa depois que ele termina.

O container é descartável e não tem endereço público — `localhost:3000` não abre do celular. Numa sessão remota, o ciclo é: mexer no código → `npm test` → republicar `demo.html` como artifact para ver a interface. Quem precisa ver o servidor de verdade é o CLI na sua máquina.

## Git

Desenvolvimento na branch `claude/viral-video-orchestration-system-smtarv`. `data/` e `node_modules/` são gitignored.
