/**
 * server.js
 * ---------------------------------------------------------------------------
 * API REST + dashboard web.
 *
 *   GET  /                              -> dashboard.html
 *   POST /api/generate-video?nicho=gta6
 *   POST /api/generate-multiple?quantidade=10&nicho=gta6
 *   GET  /api/dashboard                 -> stats + fila + videos (polling)
 *   POST /api/post-video                -> "posta" no YouTube (simulado)
 *   GET  /api/videos                    -> lista de videos
 *   GET  /api/videos/:id                -> um video
 *   GET  /api/download/:id              -> baixa o arquivo do video
 *   GET  /api/download/:id/manifest     -> baixa o manifesto JSON
 *   GET  /api/thumb/:id                 -> thumbnail (svg)
 *   GET  /api/nichos                    -> nichos suportados
 *   GET  /api/health                    -> healthcheck
 *   DELETE /api/videos                  -> limpa fila + historico
 * ---------------------------------------------------------------------------
 */

'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');

const config = require('./config');
const store = require('./store');
const queue = require('./queue');
const agents = require('./agents');
const autopilot = require('./autopilot');

const app = express();
app.use(express.json());

// Piloto automatico: marca quando alguem realmente mexeu no sistema
// (o polling do dashboard nao conta como interacao).
app.use(autopilot.middleware);

// Log simples de cada requisicao de API (ajuda a debugar no console).
app.use((req, _res, next) => {
  if (req.path.startsWith('/api') && req.path !== '/api/dashboard') {
    console.log(`→ ${req.method} ${req.originalUrl}`);
  }
  next();
});

// Helper: resposta de erro sempre no mesmo formato (e visivel no console).
function falhar(res, status, mensagem, extra = {}) {
  console.error(`❌ ${status} — ${mensagem}`);
  return res.status(status).json({ ok: false, erro: mensagem, ...extra });
}

// ============================================================ dashboard HTML

app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});

// ================================================================= API REST

/** POST /api/generate-video?nicho=gta6 */
app.post('/api/generate-video', async (req, res) => {
  try {
    const nicho = req.query.nicho || (req.body && req.body.nicho) || config.NICHO_DEFAULT;
    if (!config.NICHOS[String(nicho).toLowerCase()]) {
      return falhar(res, 400, `nicho invalido: "${nicho}"`, { nichosValidos: config.NICHOS_LISTA });
    }
    const r = await queue.addVideo({ nicho });
    res.status(202).json({ ok: true, mensagem: 'video enfileirado', ...r });
  } catch (err) {
    falhar(res, 500, err.message);
  }
});

/** POST /api/generate-multiple?quantidade=10&nicho=gta6 */
app.post('/api/generate-multiple', async (req, res) => {
  try {
    const body = req.body || {};
    const quantidade = Number(req.query.quantidade || body.quantidade || 10);
    const nicho = req.query.nicho || body.nicho || config.NICHO_DEFAULT;

    if (!Number.isFinite(quantidade) || quantidade < 1) {
      return falhar(res, 400, `quantidade invalida: "${req.query.quantidade || body.quantidade}"`);
    }
    if (!config.NICHOS[String(nicho).toLowerCase()]) {
      return falhar(res, 400, `nicho invalido: "${nicho}"`, { nichosValidos: config.NICHOS_LISTA });
    }

    const r = await queue.addMany(quantidade, nicho);
    const cortado = r.quantidade < Math.floor(quantidade);
    res.status(202).json({
      ok: true,
      mensagem: cortado
        ? `${r.quantidade} video(s) enfileirado(s) — limite de 100 por chamada (voce pediu ${Math.floor(quantidade)})`
        : `${r.quantidade} video(s) enfileirado(s)`,
      ...r,
    });
  } catch (err) {
    falhar(res, 500, err.message);
  }
});

/** GET /api/dashboard — tudo que o front precisa em uma chamada. */
app.get('/api/dashboard', async (_req, res) => {
  try {
    const fila = await queue.snapshot();
    const s = store.stats();

    res.json({
      ok: true,
      agora: new Date().toISOString(),
      stats: {
        total: s.total,
        naFila: s.queued,
        processando: s.processing,
        prontos: s.ready,
        postados: s.posted,
        falhados: s.failed,
        tempoMedioSegundos: s.tempoMedioMs ? Number((s.tempoMedioMs / 1000).toFixed(1)) : null,
        apiCallsEconomizadas: s.apiCallsEconomizadas,
        porNicho: s.porNicho,
      },
      fila,
      autopilot: autopilot.snapshot(),
      videos: store.listVideos({ limit: 100 }).map(resumoVideo),
      sistema: {
        driverFila: fila.driver,
        concorrencia: config.CONCURRENCY,
        maxTentativas: config.MAX_ATTEMPTS,
        resolucao: `${config.VIDEO.WIDTH}x${config.VIDEO.HEIGHT}`,
        nichos: config.NICHOS_LISTA.map((k) => ({ id: k, ...config.NICHOS[k] })),
        melhorias: config.MELHORIAS,
        simulacao: config.SIMULACAO.ATIVA,
      },
    });
  } catch (err) {
    falhar(res, 500, err.message);
  }
});

/** POST /api/post-video  (body ou query: { id }) */
app.post('/api/post-video', async (req, res) => {
  try {
    const id = (req.body && req.body.id) || req.query.id;
    if (!id) return falhar(res, 400, 'informe o id do video: POST /api/post-video { "id": "vid_..." }');

    const video = store.getVideo(id);
    if (!video) return falhar(res, 404, `video nao encontrado: ${id}`);
    if (video.status === 'posted') {
      return res.json({ ok: true, mensagem: 'video ja estava postado', youtube: video.youtube, video: resumoVideo(video) });
    }
    if (video.status !== 'ready') {
      return falhar(res, 409, `video ainda nao esta pronto (status: ${video.status})`);
    }

    const youtube = await agents.publicarYoutube(video, (m) => console.log(`[${id}] ${m}`));
    const atualizado = store.updateVideo(id, { status: 'posted', youtube, etapa: 'postado' });
    res.json({ ok: true, mensagem: 'video postado', youtube, video: resumoVideo(atualizado) });
  } catch (err) {
    falhar(res, 500, err.message);
  }
});

/** GET /api/videos?status=ready&nicho=gta6 */
app.get('/api/videos', (req, res) => {
  const { status, nicho } = req.query;
  res.json({ ok: true, videos: store.listVideos({ status, nicho, limit: 200 }).map(resumoVideo) });
});

/** GET /api/videos/:id — registro completo. */
app.get('/api/videos/:id', (req, res) => {
  const video = store.getVideo(req.params.id);
  if (!video) return falhar(res, 404, `video nao encontrado: ${req.params.id}`);
  res.json({ ok: true, video });
});

/** GET /api/download/:id — baixa o arquivo final. */
app.get('/api/download/:id', (req, res) => {
  const video = store.getVideo(req.params.id);
  if (!video) return falhar(res, 404, `video nao encontrado: ${req.params.id}`);
  if (!video.arquivo || !fs.existsSync(video.arquivo)) {
    return falhar(res, 404, 'arquivo do video ainda nao existe (video nao terminou de ser gerado)');
  }
  res.download(video.arquivo);
});

/**
 * GET /api/watch/:id — toca o vídeo no navegador (inline, com suporte a seek).
 * Diferente de /api/download, que força o salvamento do arquivo.
 */
app.get('/api/watch/:id', (req, res) => {
  const video = store.getVideo(req.params.id);
  if (!video) return falhar(res, 404, `video nao encontrado: ${req.params.id}`);
  if (!video.arquivo || !fs.existsSync(video.arquivo)) {
    return falhar(res, 404, 'arquivo do video ainda nao existe');
  }
  if (video.render !== 'real') {
    return falhar(res, 409, 'este video é um placeholder (sem ffmpeg na maquina) — nao ha o que tocar');
  }
  // sendFile já trata Range/206, que é o que o <video> usa para avançar.
  res.type(path.extname(video.arquivo) === '.webm' ? 'video/webm' : 'video/mp4');
  res.sendFile(video.arquivo);
});

/** GET /api/download/:id/manifest — manifesto JSON (timeline, script, etc). */
app.get('/api/download/:id/manifest', (req, res) => {
  const video = store.getVideo(req.params.id);
  const arquivo = video && video.arquivos && video.arquivos.manifesto;
  if (!arquivo || !fs.existsSync(arquivo)) return falhar(res, 404, 'manifesto nao encontrado');
  res.download(arquivo);
});

/** GET /api/thumb/:id — thumbnail da primeira cena (png no modo real). */
app.get('/api/thumb/:id', (req, res) => {
  const video = store.getVideo(req.params.id);
  const arquivo = video && video.arquivos && video.arquivos.thumbnail;
  if (!arquivo || !fs.existsSync(arquivo)) return res.status(404).end();
  res.type(arquivo.endsWith('.png') ? 'image/png' : 'image/svg+xml').sendFile(arquivo);
});

/** GET /api/nichos */
app.get('/api/nichos', (_req, res) => {
  res.json({ ok: true, nichos: config.NICHOS_LISTA.map((k) => ({ id: k, ...config.NICHOS[k] })) });
});

/** GET /api/health */
app.get('/api/health', async (_req, res) => {
  const contadores = await queue.counts(); // ja tem prazo: nao pendura
  res.json({
    ok: true,
    status: contadores.offline ? 'degradado' : 'up',
    filaOffline: Boolean(contadores.offline),
    driverFila: queue.driver,
    uptimeSegundos: Math.round(process.uptime()),
    contadores,
    autopilot: autopilot.snapshot(),
  });
});

/**
 * POST /api/autopilot — liga/desliga o piloto automatico.
 * body `{ "ativo": true }` ou query `?ativo=false`
 */
app.post('/api/autopilot', (req, res) => {
  const bruto = (req.body && req.body.ativo !== undefined) ? req.body.ativo : req.query.ativo;
  if (bruto === undefined) return falhar(res, 400, 'informe ativo: POST /api/autopilot { "ativo": true }');
  const ativo = /^(1|true|on|sim)$/i.test(String(bruto));
  res.json({ ok: true, autopilot: autopilot.setAtivo(ativo) });
});

/** GET /api/autopilot — estado do piloto automatico. */
app.get('/api/autopilot', (_req, res) => res.json({ ok: true, autopilot: autopilot.snapshot() }));

/** DELETE /api/videos — zera fila + historico (util em testes). */
app.delete('/api/videos', async (_req, res) => {
  try {
    const removidos = await queue.clear();
    agents.limparCacheLotes();
    res.json({ ok: true, mensagem: `${removidos} registro(s) removido(s)` });
  } catch (err) {
    falhar(res, 500, err.message);
  }
});

app.use((req, res) => falhar(res, 404, `rota nao encontrada: ${req.method} ${req.path}`));

// Handler de erro do Express (JSON invalido no body, etc).
app.use((err, _req, res, _next) => falhar(res, 400, `requisicao invalida: ${err.message}`));

// ================================================================ utilitarios

/** Projecao enxuta de um video para as listas do dashboard. */
function resumoVideo(v) {
  if (!v) return null;
  return {
    id: v.id,
    titulo: v.titulo || v.topico || '(gerando...)',
    nicho: v.nicho,
    status: v.status,
    etapa: v.etapa,
    progresso: v.progresso,
    tentativas: v.tentativas,
    duracao: v.duracao,
    tempoGeracaoSegundos: v.tempoGeracao ? Number((v.tempoGeracao / 1000).toFixed(1)) : null,
    hashtags: v.hashtags,
    erro: v.erro,
    youtube: v.youtube,
    lote: v.lote,
    origem: v.origem || 'manual',
    temArquivo: Boolean(v.arquivo),
    render: v.render || null,
    assistivel: v.render === 'real' && Boolean(v.arquivo),
    criadoEm: v.criadoEm,
  };
}

// ===================================================================== start

async function start() {
  console.log('\n🎬 Viral Video Orchestrator');
  console.log('─'.repeat(60));

  const driver = await queue.init();
  autopilot.start(queue);

  const renderReal = await require('./render').disponivel();
  console.log(renderReal
    ? '🎞️ render: ffmpeg encontrado — os videos saem em MP4 1080x1920 de verdade'
    : '🎞️ render: ffmpeg NAO encontrado — os videos saem como placeholder (instale o ffmpeg para gerar mp4)');

  const server = app.listen(config.PORT, config.HOST, () => {
    console.log(`🌐 dashboard: http://localhost:${config.PORT}`);
    console.log(`📡 api:       http://localhost:${config.PORT}/api/dashboard`);
    console.log(`🎞️  formato:   ${config.VIDEO.WIDTH}x${config.VIDEO.HEIGHT} @ ${config.VIDEO.FPS}fps (${config.VIDEO.MIN_DURATION}-${config.VIDEO.MAX_DURATION}s)`);
    console.log(`🧩 nichos:    ${config.NICHOS_LISTA.join(', ')}`);
    console.log(`⚙️  melhorias: paralelo=${config.MELHORIAS.PARALELO} retry=${config.MAX_ATTEMPTS}x limpeza=${config.MELHORIAS.LIMPEZA_TEMP} anti-repeticao=${config.MELHORIAS.ANTI_REPETICAO} lote=${config.MELHORIAS.LOTE_PESQUISA}`);
    console.log('─'.repeat(60));
    console.log(`🤖 piloto auto: apos ${Math.round(config.AUTOPILOT.IDLE_MS / 60000)} min sem ninguem mexer, o sistema continua gerando sozinho`);
    console.log('─'.repeat(60));
    console.log('Pronto! Abra o dashboard e clique em "Gerar 1 Video".\n');
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\n❌ a porta ${config.PORT} ja esta em uso. Rode com outra porta:  PORT=3001 npm start\n`);
    } else {
      console.error('\n❌ erro ao subir o servidor:', err.message, '\n');
    }
    process.exit(1);
  });

  // Shutdown limpo: salva o banco e fecha a fila.
  const encerrar = async (sinal) => {
    console.log(`\n${sinal} recebido, encerrando...`);
    server.close();
    autopilot.stop();
    await queue.close();
    process.exit(0);
  };
  process.on('SIGINT', () => encerrar('SIGINT'));
  process.on('SIGTERM', () => encerrar('SIGTERM'));

  // Nunca derrubar o processo silenciosamente.
  process.on('unhandledRejection', (err) => console.error('❌ promise rejeitada sem catch:', err));
  process.on('uncaughtException', (err) => console.error('❌ excecao nao tratada:', err));

  return { app, server, driver };
}

if (require.main === module) {
  start().catch((err) => {
    console.error('\n❌ falha ao iniciar:', err.stack || err.message, '\n');
    process.exit(1);
  });
}

module.exports = { app, start };
