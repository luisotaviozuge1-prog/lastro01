# 🎬 Viral Video Orchestrator

Sistema completo de orquestração de vídeos virais (Shorts 1080x1920) com **5 agentes especializados**, **fila de trabalhos**, **dashboard web** e **API REST**.

Roda **agora**, sem configurar nada:

```bash
npm install
npm start
# abre http://localhost:3000
```

Sem Redis instalado? Funciona igual — o sistema cai automaticamente para a fila em memória e avisa no console.

---

## 🔗 Acesso rápido (sem instalar nada)

| O quê | Onde |
|---|---|
| **Demo clicável** (mesmo pipeline, rodando no navegador) | https://claude.ai/artifact/GCdUZ5iLw17ZEd9Sqxet34 |
| **Demo local** (abre com dois cliques, offline, sem npm) | `demo.html` |
| **Sistema real** (fila, Redis, API, arquivos em disco) | `npm install && npm start` → http://localhost:3000 |

O `demo.html` é uma porta fiel do pipeline para o navegador: os mesmos 5 agentes, concorrência 2, retry com backoff, anti-repetição, pesquisa em lote e o piloto automático (com 30s de inatividade em vez de 5 min, para você ver funcionando sem esperar). Ele **não** substitui o servidor: quem grava arquivo em disco, usa BullMQ/Redis e expõe a API é o `npm start`.

---

## 🚀 Teste rápido

```bash
npm install
npm test     # 60 verificações de ponta a ponta (~4s, sem Redis, sem API externa)
npm start    # sobe o servidor em :3000
```

No dashboard:

1. Escolha o nicho
2. **▶ Gerar 1 Vídeo** → acompanha a barra de progresso em tempo real
3. **⚡ Gerar 10 Vídeos** → a fila processa 2 por vez, sem travar
4. **📤 POSTAR** → "envia" pro YouTube e mostra a URL
5. **⬇ baixar** / **{ } json** → baixa o vídeo e o manifesto (timeline, script, hashtags)

---

## 🤖 Piloto automático ("fique ligado")

Se **ninguém mexer por 5 minutos**, o servidor não fica parado: ele continua ligado e **gerando vídeos sozinho**, alternando entre os nichos.

```
🤖 PILOTO AUTOMATICO: 5 min sem ninguem mexer — gerando 2 video(s) sozinho
💓 ligado · inativo ha 6 min · piloto automatico LIGADO · 14 video(s) gerado(s) sozinho
```

- **O que conta como "alguém mexeu"**: qualquer POST/DELETE na API (gerar, postar, limpar) e downloads
- **O que não conta**: o polling do dashboard (senão o piloto nunca ligaria com a aba aberta)
- **Para na hora** em que você volta a clicar — e volta a assumir quando você sai de novo
- **Heartbeat** no console a cada minuto provando que está vivo
- Os vídeos criados sozinho aparecem com a tag **🤖 AUTO** no dashboard
- Liga/desliga pelo botão **🤖 Piloto automático** ou por `POST /api/autopilot { "ativo": false }`

Travas de segurança (para não lotar o disco sozinho):

| Trava | Padrão | Variável |
|---|---|---|
| máximo de trabalhos pendentes | 4 | `AUTO_PILOT_MAX_FILA` |
| máximo por hora | 20 | `AUTO_PILOT_MAX_POR_HORA` |
| vídeos por ciclo | 2 | `AUTO_PILOT_LOTE` |
| tempo de inatividade | 5 min | `AUTO_PILOT_IDLE_MS` |
| de quanto em quanto verifica | 30s | `AUTO_PILOT_CHECK_MS` |
| desligar de vez | — | `AUTO_PILOT=false` |

Para ver funcionando em segundos, sem esperar 5 minutos:

```bash
AUTO_PILOT_IDLE_MS=8000 AUTO_PILOT_CHECK_MS=2000 npm start
# saia do teclado por 10s e veja o console gerando sozinho
```

---

## 🤖 Os 5 agentes

| Agente | Arquivo | O que faz |
|---|---|---|
| 🔍 **Agent Pesquisa** | `agents.js` → `agentPesquisa` | Busca curiosidades/conteúdo viral, com score de viralidade, anti-repetição e pesquisa em lote |
| ✍️ **Agent Roteiro** | `agents.js` → `agentRoteiro` | Escreve o script catchy, garante 20–30s, divide em cenas |
| 🎙️ **Agent Áudio** | `agents.js` → `agentAudio` | Gera a narração (voz por nicho, duração, bitrate) |
| 🎨 **Agent Imagens** | `agents.js` → `agentImagens` | Cria os visuais 1080x1920 (um por cena, com legenda) |
| 🎬 **Agent Edição** | `agents.js` → `agentEdicao` | Monta a timeline, aplica transições e escreve o vídeo final + manifesto + thumbnail |

Pipeline (em `orchestrator.js`):

```
🔍 Pesquisa  →  ✍️ Roteiro  →  ┌─ 🎙️ Áudio   ─┐  →  🎬 Edição
                              └─ 🎨 Imagens ─┘
                               (em PARALELO)
```

---

## ✅ As 5 melhorias integradas

| # | Melhoria | Onde está | Como conferir |
|---|---|---|---|
| 1️⃣ | **Paralelo nos agentes** — Áudio e Imagens ao mesmo tempo (~40% mais rápido) | `orchestrator.js` (`Promise.all`) | o console mostra `⚡ mídia pronta em XXXms (paralelo)`; o teste mede o ganho real |
| 2️⃣ | **Retry automático** — até 3 tentativas com backoff exponencial (1s, 2s, 4s) | `queue.js` (BullMQ `attempts` + `MemoryQueue.executar`) | `AGENT_FAIL_RATE=0.35 npm start` → veja `🔁` no console e `tentativa 2/3` no dashboard |
| 3️⃣ | **Limpeza de temp** — a pasta temporária do job é apagada sempre (no `finally`), inclusive em caso de erro, e órfãos são limpos no boot | `orchestrator.js` (`limparPasta`, `limparTempOrfaos`) | `ls data/temp` fica vazio depois de qualquer rodada |
| 4️⃣ | **Anti-repetição** — não reutiliza um tópico usado nos últimos 10 vídeos do nicho; se o lote esgotar, gera um ângulo novo | `agents.js` + `store.recentTopicIds()` | gere 10 vídeos do mesmo nicho → 10 títulos diferentes |
| 5️⃣ | **Agrupamento em lote** — 1 pesquisa por nicho serve vários vídeos (cache com TTL de 5 min) | `agents.js` (`cacheLotes`) | o dashboard mostra `economia: N chamadas`; 10 vídeos = 1 chamada + 9 economizadas |

---

## 🧵 Sistema de fila

Dois drivers, **a mesma API** (`queue.js`):

| Driver | Quando entra | O que oferece |
|---|---|---|
| **BullMQ + Redis** | Redis responde em `REDIS_URL` | fila persistente, retry, backoff, progresso no Redis |
| **Memória (fallback)** | sem Redis | mesma concorrência, mesmo retry, mesmo progresso — só não persiste entre reinícios |

- **Máximo 2–3 vídeos simultâneos** (`CONCURRENCY=2` por padrão, limitado a 5)
- **Retry automático**: 3 tentativas, backoff exponencial
- **Progresso em tempo real**: cada etapa grava `%` + nome da etapa no store, o dashboard faz polling a cada 1,5s
- **10+ vídeos sem travar**: o `POST` responde na hora (202) e a fila drena no ritmo da concorrência
- **Timeout de segurança** por job (`JOB_TIMEOUT_MS`), nenhum trabalho fica preso para sempre
- Vídeos que ficaram `processing` quando o servidor caiu são marcados como falha no próximo boot (o dashboard nunca mente)

Para usar o Redis:

```bash
redis-server --daemonize yes      # ou: docker run -p 6379:6379 redis
npm start                         # o console mostra: 🧵 fila: BullMQ + Redis
```

---

## 📡 API REST

| Método | Rota | Descrição |
|---|---|---|
| `POST` | `/api/generate-video?nicho=gta6` | enfileira 1 vídeo → `202 { videoId, jobId }` |
| `POST` | `/api/generate-multiple?quantidade=10&nicho=gta6` | enfileira N vídeos → `202 { lote, quantidade, itens }` |
| `GET` | `/api/dashboard` | stats + fila + vídeos + config (tudo numa chamada) |
| `POST` | `/api/post-video` | body `{ "id": "vid_..." }` → "posta" no YouTube |
| `GET` | `/api/videos?status=ready&nicho=gta6` | lista de vídeos |
| `GET` | `/api/videos/:id` | registro completo (script, timeline, arquivos) |
| `GET` | `/api/download/:id` | baixa o arquivo do vídeo |
| `GET` | `/api/download/:id/manifest` | baixa o manifesto JSON |
| `GET` | `/api/thumb/:id` | thumbnail |
| `GET` | `/api/nichos` | nichos suportados |
| `POST` | `/api/autopilot` | liga/desliga o piloto: `{ "ativo": true }` |
| `GET` | `/api/autopilot` | estado do piloto (inatividade, gerados sozinho, travas) |
| `GET` | `/api/health` | healthcheck + contadores da fila + piloto |
| `DELETE` | `/api/videos` | limpa fila + histórico |

Exemplos:

```bash
curl -X POST "http://localhost:3000/api/generate-video?nicho=gta6"
curl -X POST "http://localhost:3000/api/generate-multiple?quantidade=10&nicho=easter-eggs"
curl -s http://localhost:3000/api/dashboard | jq .stats
curl -X POST http://localhost:3000/api/post-video -H 'Content-Type: application/json' -d '{"id":"vid_xxx"}'
```

Erros sempre vêm no mesmo formato e aparecem no console:

```json
{ "ok": false, "erro": "nicho invalido: \"xpto\"", "nichosValidos": ["gta6", "..."] }
```

---

## 🧩 Nichos suportados

| id | Nicho | Voz da narração |
|---|---|---|
| `gta6` | 🎮 GTA 6 | `pt-BR-Hype-Male` |
| `curiosidades-games` | 🤯 Curiosidades de Games | `pt-BR-Narrator-Female` |
| `dicas-gameplay` | 🕹️ Dicas de Gameplay | `pt-BR-Coach-Male` |
| `easter-eggs` | 🥚 Easter Eggs | `pt-BR-Mystery-Male` |

Cada nicho tem 12 tópicos reais na base (`BASE_CONTEUDO` em `agents.js`) + hashtags próprias. Adicionar um nicho novo = adicionar uma entrada em `config.NICHOS` e um array em `BASE_CONTEUDO`.

---

## 📁 Estrutura

```
package.json      dependências + scripts
config.js         toda a configuração (nichos, fila, vídeo, melhorias)
agents.js         os 5 agentes + publicação no YouTube
orchestrator.js   pipeline de 1 vídeo (paralelo + limpeza de temp)
queue.js          fila de trabalhos (BullMQ/Redis com fallback em memória)
autopilot.js      piloto automático: continua gerando quando ninguém mexe
store.js          persistência JSON (data/videos.json) + anti-repetição + stats
server.js         API REST + servidor do dashboard
dashboard.html    dashboard web do servidor (HTML + Fetch API, sem build)
demo.html         demo do pipeline rodando 100% no navegador (sem backend)
test.js           teste rápido de ponta a ponta
README.md         este arquivo

data/             criado em runtime (gitignored)
  videos.json       banco
  output/           vídeos finais + manifestos + thumbnails
  temp/             arquivos temporários (limpos automaticamente)
```

---

## ⚙️ Configuração (variáveis de ambiente)

| Variável | Padrão | Para quê |
|---|---|---|
| `PORT` | `3000` | porta do servidor |
| `CONCURRENCY` | `2` | vídeos processando ao mesmo tempo (máx. 5) |
| `MAX_ATTEMPTS` | `3` | tentativas por vídeo |
| `BACKOFF_MS` | `1000` | base do backoff exponencial |
| `REDIS_URL` | `redis://127.0.0.1:6379` | Redis do BullMQ |
| `USE_REDIS` | `true` | `false` força a fila em memória |
| `SIM_SPEED` | `1` | velocidade da simulação (`0.2` = 5x mais rápido) |
| `AGENT_FAIL_RATE` | `0` | falha artificial por agente (use `0.3` para ver o retry) |
| `ANTI_REPETICAO_JANELA` | `10` | quantos vídeos olhar para trás |
| `LOTE_TAMANHO` | `12` | tópicos por lote de pesquisa |
| `JOB_TIMEOUT_MS` | `180000` | timeout de segurança por vídeo |
| `AUTO_PILOT` | `true` | piloto automático ligado |
| `AUTO_PILOT_IDLE_MS` | `300000` | 5 min de inatividade para o piloto assumir |
| `AUTO_PILOT_LOTE` | `2` | vídeos por ciclo do piloto |
| `AUTO_PILOT_MAX_POR_HORA` | `20` | teto de vídeos automáticos por hora |

Exemplos:

```bash
CONCURRENCY=3 npm start                    # 3 vídeos por vez
AGENT_FAIL_RATE=0.3 npm start              # demonstra o retry automático
SIM_SPEED=0.2 npm start                    # pipeline 5x mais rápido (demo)
USE_REDIS=false npm start                  # ignora o Redis de propósito
```

---

## 🧪 Modo simulação (e como plugar as APIs reais)

Hoje nada depende de API externa: os agentes simulam latência e **escrevem arquivos de verdade** em `data/output/` (vídeo placeholder, manifesto JSON com timeline/script/hashtags e thumbnail SVG 1080x1920).

Cada agente tem um comentário **`PLUG AQUI`** marcando exatamente onde entra a integração real:

| Agente | Plugar |
|---|---|
| Pesquisa | Google Trends / Reddit API / YouTube Data API |
| Roteiro | Claude / GPT |
| Áudio | ElevenLabs / Azure TTS / Google TTS |
| Imagens | DALL·E / Stable Diffusion / Pexels |
| Edição | `ffmpeg` (o comando sugerido está no comentário) |
| Postagem | YouTube Data API v3 (`videos.insert`) |

A estrutura de dados já é a final — trocar a simulação pela API real não muda o pipeline, a fila nem o dashboard.

---

## 🩺 Se algo falhar

O console mostra o erro com contexto. Os casos comuns:

| Mensagem | O que fazer |
|---|---|
| `a porta 3000 ja esta em uso` | `PORT=3001 npm start` |
| `🧵 fila: MEMORIA (Redis nao encontrado...)` | normal — tudo funciona; suba um Redis se quiser persistência |
| `🔁 video ...: tentativa 1 falhou` | retry em ação, nada a fazer |
| `💀 video ... falhou depois de 3 tentativas` | erro real: a mensagem do agente aparece no dashboard e no log |
| `videos.json invalido, iniciando banco novo` | o banco foi corrompido; o sistema se recupera sozinho |
| `timeout de 180000ms excedido` | algum agente travou; ajuste `JOB_TIMEOUT_MS` |

### Comportamentos que são de propósito

- **"Limpar tudo" descarta trabalho em andamento**: os jobs que já estavam processando terminam, mas seus registros foram apagados — é uma ação destrutiva, o dashboard pede confirmação.
- **`quantidade` acima de 100 é cortada em 100** por chamada; a resposta devolve a quantidade real enfileirada.
- **Anti-repetição é uma janela, não um bloqueio eterno**: a partir do 11º vídeo do mesmo nicho, um tópico usado há mais de 10 vídeos pode voltar — é exatamente a regra pedida ("não repetir nos últimos 10").
- **Vídeos `processing` de um servidor que caiu** viram `failed` no próximo boot, com o motivo `servidor reiniciado durante o processamento`.
- **Limpeza de temp no boot** só apaga pastas paradas há mais de 5 min, para não atropelar outra instância usando o mesmo `DATA_DIR`.
