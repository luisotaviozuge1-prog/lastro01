/**
 * test.js — teste rapido de ponta a ponta (sem framework, sem Redis)
 * ---------------------------------------------------------------------------
 * Roda com:  npm test
 *
 * O que ele valida:
 *   1) Pipeline completo de 1 video (os 5 agentes)
 *   2) Fila: 10 videos sem travar, respeitando a concorrencia
 *   3) MELHORIA 1 — paralelo: audio+imagens juntos
 *   4) MELHORIA 2 — retry automatico (com falha forcada)
 *   5) MELHORIA 3 — limpeza da pasta temporaria
 *   6) MELHORIA 4 — anti-repeticao de topicos
 *   7) MELHORIA 5 — pesquisa em lote (economia de chamadas de API)
 *   8) API REST: generate-video, generate-multiple, dashboard, post-video
 * ---------------------------------------------------------------------------
 */

'use strict';

// Ambiente de teste: rapido, isolado e sem Redis.
process.env.DATA_DIR = process.env.DATA_DIR || require('path').join(__dirname, 'data', 'test');
process.env.USE_REDIS = process.env.USE_REDIS || 'false';
process.env.SIM_SPEED = process.env.SIM_SPEED || '0.08'; // ~12x mais rapido
process.env.PORT = process.env.PORT || '3999';
process.env.BACKOFF_MS = process.env.BACKOFF_MS || '50';

const fs = require('fs');
const path = require('path');
const http = require('http');

const config = require('./config');
const store = require('./store');
const agents = require('./agents');
const orchestrator = require('./orchestrator');
const queue = require('./queue');

let passou = 0;
let falhou = 0;

function ok(cond, msg, extra = '') {
  if (cond) { passou++; console.log(`  ✅ ${msg}`); }
  else { falhou++; console.error(`  ❌ ${msg}${extra ? ' — ' + extra : ''}`); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Espera uma condicao virar verdadeira (com timeout claro). */
async function esperar(fn, timeoutMs, label) {
  const limite = Date.now() + timeoutMs;
  while (Date.now() < limite) {
    if (await fn()) return true;
    await sleep(120);
  }
  throw new Error(`timeout esperando: ${label}`);
}

/** Requisicao HTTP simples (sem dependencia extra). */
function req(metodo, caminho, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const r = http.request(
      { host: '127.0.0.1', port: config.PORT, path: caminho, method: metodo,
        headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {} },
      (res) => {
        let dados = '';
        res.on('data', (c) => (dados += c));
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: dados ? JSON.parse(dados) : {} }); }
          catch { resolve({ status: res.statusCode, body: dados }); }
        });
      }
    );
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

async function main() {
  console.log('\n🧪 TESTE RAPIDO — Viral Video Orchestrator');
  console.log('='.repeat(62));
  console.log(`modo: sem Redis · velocidade ${config.SIMULACAO.VELOCIDADE}x · dados em ${config.PATHS.DATA}\n`);

  // Comeca de um estado limpo.
  fs.rmSync(config.PATHS.DATA, { recursive: true, force: true });
  store.ensureDirs();

  // ------------------------------------------------- 1) pipeline de 1 video
  console.log('1) Pipeline completo (5 agentes)');
  const videoId = orchestrator.novoVideoId();
  store.createVideo({ id: videoId, nicho: 'gta6' });
  const etapasVistas = new Set();
  const t0 = Date.now();
  const registro = await orchestrator.processVideo(
    { videoId, nicho: 'gta6' },
    (_p, etapa) => etapasVistas.add(etapa)
  );
  const tempo1 = Date.now() - t0;

  ok(registro.status === 'ready', 'video terminou com status "ready"', registro.status);
  ok(Boolean(registro.titulo), 'tem titulo gerado pelo Agent Roteiro');
  ok(Boolean(registro.script), 'tem script gerado');
  ok(registro.progresso === 100, 'progresso chegou a 100%');
  ok(fs.existsSync(registro.arquivo), 'arquivo de video existe em disco');
  ok(fs.existsSync(registro.arquivos.manifesto), 'manifesto JSON existe em disco');
  ok(fs.existsSync(registro.arquivos.thumbnail), 'thumbnail existe em disco');
  ok(registro.resolucao === '1080x1920', 'resolucao vertical 1080x1920', registro.resolucao);
  ok(
    registro.duracao >= config.VIDEO.MIN_DURATION && registro.duracao <= config.VIDEO.MAX_DURATION + 2,
    `duracao dentro de 20-30s (${registro.duracao}s)`
  );

  const manifesto = JSON.parse(fs.readFileSync(registro.arquivos.manifesto, 'utf8'));
  ok(manifesto.timeline.length > 0, `timeline montada com ${manifesto.timeline.length} cena(s)`);
  ok(manifesto.hashtags.length > 0, 'hashtags do nicho aplicadas');

  // ------------------------------------------------- MELHORIA 1 — paralelo
  console.log('\n2) MELHORIA 1 — audio + imagens em paralelo');
  ok(config.MELHORIAS.PARALELO, 'melhoria habilitada no config');
  ok(etapasVistas.has('audio+imagens'), 'pipeline reportou a etapa paralela "audio+imagens"');

  const ctxParalelo = { videoId: 'bench', nicho: 'gta6', tempDir: path.join(config.PATHS.TEMP, 'bench') };
  fs.mkdirSync(ctxParalelo.tempDir, { recursive: true });
  Object.assign(ctxParalelo, await agents.agentPesquisa(ctxParalelo, () => {}));
  Object.assign(ctxParalelo, await agents.agentRoteiro(ctxParalelo, () => {}));

  const tSerie = Date.now();
  await agents.agentAudio(ctxParalelo, () => {});
  await agents.agentImagens(ctxParalelo, () => {});
  const msSerie = Date.now() - tSerie;

  const tPar = Date.now();
  await Promise.all([agents.agentAudio(ctxParalelo, () => {}), agents.agentImagens(ctxParalelo, () => {})]);
  const msPar = Date.now() - tPar;
  const ganho = Math.round((1 - msPar / msSerie) * 100);
  ok(msPar < msSerie, `paralelo e mais rapido que serial (${msPar}ms vs ${msSerie}ms = ~${ganho}% de economia)`);
  fs.rmSync(ctxParalelo.tempDir, { recursive: true, force: true });

  // ------------------------------------------- MELHORIA 3 — limpeza de temp
  console.log('\n3) MELHORIA 3 — limpeza dos arquivos temporarios');
  ok(!fs.existsSync(path.join(config.PATHS.TEMP, videoId)), 'pasta temporaria do video foi removida');
  const restos = fs.existsSync(config.PATHS.TEMP) ? fs.readdirSync(config.PATHS.TEMP) : [];
  ok(restos.length === 0, 'nenhum resto na pasta temp', restos.join(','));

  // -------------------------------------------- MELHORIA 5 — pesquisa lote
  console.log('\n4) MELHORIA 5 — pesquisa agrupada em lote');
  agents.limparCacheLotes();
  const economizadasAntes = store.stats().apiCallsEconomizadas;
  const ctxA = { videoId: 'a', nicho: 'easter-eggs', tempDir: config.PATHS.TEMP };
  const p1 = await agents.agentPesquisa(ctxA, () => {});
  const p2 = await agents.agentPesquisa(ctxA, () => {});
  const p3 = await agents.agentPesquisa(ctxA, () => {});
  ok(p1.pesquisa.veioDoCache === false, '1a pesquisa fez a chamada de API (busca o lote)');
  ok(p2.pesquisa.veioDoCache && p3.pesquisa.veioDoCache, '2a e 3a pesquisas vieram do lote em cache');
  ok(store.stats().apiCallsEconomizadas === economizadasAntes + 2, 'contador de chamadas economizadas subiu 2');

  // ------------------------------------------ MELHORIA 4 — anti-repeticao
  console.log('\n5) MELHORIA 4 — anti-repeticao de topicos');
  ok(config.MELHORIAS.ANTI_REPETICAO, 'melhoria habilitada no config');
  const topicos = [];
  for (let i = 0; i < 5; i++) {
    const id = orchestrator.novoVideoId();
    store.createVideo({ id, nicho: 'dicas-gameplay' });
    const ctx = { videoId: id, nicho: 'dicas-gameplay', tempDir: config.PATHS.TEMP };
    const r = await agents.agentPesquisa(ctx, () => {});
    store.updateVideo(id, { topicoId: r.pesquisa.topicoId, topico: r.pesquisa.titulo, titulo: r.pesquisa.titulo, status: 'ready' });
    topicos.push(r.pesquisa.topicoId);
  }
  ok(new Set(topicos).size === topicos.length, `5 pesquisas seguidas = 5 topicos diferentes (${new Set(topicos).size}/5)`);

  // --------------------------------------------- MELHORIA 2 — retry
  console.log('\n6) MELHORIA 2 — retry automatico (falha forcada)');
  let tentativas = 0;
  const filaRetry = new queue.MemoryQueue({
    concurrency: 1,
    attempts: config.MAX_ATTEMPTS,
    backoffMs: 10,
    processor: async () => {
      tentativas++;
      if (tentativas < 3) throw new Error('falha proposital');
      return true;
    },
  });
  filaRetry.add({ videoId: 'retry-test' });
  await esperar(() => filaRetry.counts().completed === 1, 5000, 'job com retry concluir');
  ok(tentativas === 3, `job tentou 3 vezes e passou na ultima (tentativas=${tentativas})`);

  let tentativasFatais = 0;
  const filaFatal = new queue.MemoryQueue({
    concurrency: 1, attempts: config.MAX_ATTEMPTS, backoffMs: 10,
    processor: async () => { tentativasFatais++; throw new Error('sempre falha'); },
  });
  store.createVideo({ id: 'vid_fatal', nicho: 'gta6' });
  filaFatal.add({ videoId: 'vid_fatal' });
  await esperar(() => filaFatal.counts().failed === 1, 5000, 'job falhar de vez');
  ok(tentativasFatais === config.MAX_ATTEMPTS, `desistiu depois de ${config.MAX_ATTEMPTS} tentativas`);
  ok(store.getVideo('vid_fatal').status === 'failed', 'video marcado como "failed" no store');
  store.removeVideo('vid_fatal');

  // ----------------------------------------------------- 7) API + 10 videos
  console.log('\n7) API REST + 10 videos na fila');
  const { start } = require('./server');
  const { server, driver } = await start();
  ok(driver === 'memory', `driver de fila em modo fallback: ${driver}`);

  const health = await req('GET', '/api/health');
  ok(health.status === 200 && health.body.status === 'up', 'GET /api/health responde');

  const nichos = await req('GET', '/api/nichos');
  ok(nichos.body.nichos.length === 4, `GET /api/nichos lista os 4 nichos (${nichos.body.nichos.map((n) => n.id).join(', ')})`);

  const um = await req('POST', '/api/generate-video?nicho=curiosidades-games');
  ok(um.status === 202 && um.body.videoId, 'POST /api/generate-video enfileira');

  const invalido = await req('POST', '/api/generate-video?nicho=nao-existe');
  ok(invalido.status === 400, 'nicho invalido retorna erro 400 claro');

  const dez = await req('POST', '/api/generate-multiple?quantidade=10&nicho=gta6');
  ok(dez.status === 202 && dez.body.quantidade === 10, 'POST /api/generate-multiple enfileira 10 videos');

  const dash = await req('GET', '/api/dashboard');
  ok(dash.status === 200 && dash.body.ok, 'GET /api/dashboard responde');
  ok(dash.body.fila.trabalhos.length > 0, 'dashboard mostra trabalhos na fila');

  // Respeita a concorrencia enquanto processa
  let maxSimultaneos = 0;
  const monitor = setInterval(async () => {
    try {
      const d = await req('GET', '/api/dashboard');
      maxSimultaneos = Math.max(maxSimultaneos, d.body.stats.processando);
    } catch {}
  }, 150);

  console.log('   ...aguardando os 11 videos terminarem (fila com concorrencia 2)');
  await esperar(async () => {
    const d = await req('GET', '/api/dashboard');
    return d.body.stats.naFila === 0 && d.body.stats.processando === 0;
  }, 120000, 'fila esvaziar');
  clearInterval(monitor);

  const finalDash = (await req('GET', '/api/dashboard')).body;
  ok(maxSimultaneos > 0 && maxSimultaneos <= config.CONCURRENCY,
    `concorrencia respeitada: no maximo ${maxSimultaneos} de ${config.CONCURRENCY} simultaneos`);
  ok(finalDash.stats.prontos >= 11, `todos os videos ficaram prontos (${finalDash.stats.prontos} prontos, ${finalDash.stats.falhados} falhas)`);
  ok(finalDash.stats.falhados === 0, 'nenhuma falha na leva de 10+ videos');
  ok(finalDash.stats.apiCallsEconomizadas >= 9, `pesquisa em lote economizou ${finalDash.stats.apiCallsEconomizadas} chamadas de API`);

  // Anti-repeticao: os 10 videos do mesmo lote/nicho devem ter 10 topicos
  // diferentes (a janela de anti-repeticao e de 10 videos).
  const prontos = (await req('GET', '/api/videos?status=ready')).body.videos;
  const doLote = prontos.filter((v) => v.lote === dez.body.lote);
  const titulosUnicos = new Set(doLote.map((v) => v.titulo));
  ok(doLote.length === 10, `os 10 videos do lote ${dez.body.lote} ficaram prontos (${doLote.length})`);
  ok(titulosUnicos.size === doLote.length,
    `anti-repeticao no lote de 10: ${titulosUnicos.size}/${doLote.length} titulos unicos`);
  ok(prontos.every((v) => v.titulo && v.titulo !== '(gerando...)'), 'todos os videos prontos tem titulo');

  // ------------------------------------------------------ 8) postar video
  console.log('\n8) Postar no YouTube (simulado)');
  const alvo = prontos[0];
  const post = await req('POST', '/api/post-video', { id: alvo.id });
  ok(post.status === 200 && post.body.youtube.url.includes('youtube.com/shorts/'),
    `POST /api/post-video devolve a URL: ${post.body.youtube && post.body.youtube.url}`);
  ok(store.getVideo(alvo.id).status === 'posted', 'video marcado como "posted"');

  const semId = await req('POST', '/api/post-video', {});
  ok(semId.status === 400, 'post sem id retorna erro 400 claro');

  const naoExiste = await req('POST', '/api/post-video', { id: 'vid_naoexiste' });
  ok(naoExiste.status === 404, 'post de video inexistente retorna 404');

  // ------------------------------------------------------------- download
  const download = await req('GET', `/api/download/${alvo.id}/manifest`);
  ok(download.status === 200, 'GET /api/download/:id/manifest baixa o manifesto');

  // --------------------------------------------------------------- fim
  server.close();
  await queue.close();

  const tempoTotal = ((Date.now() - t0) / 1000).toFixed(1);
  console.log('\n' + '='.repeat(62));
  console.log(`RESULTADO: ${passou} passou · ${falhou} falhou · ${tempoTotal}s`);
  console.log(`(1 video levou ${(tempo1 / 1000).toFixed(1)}s na velocidade de teste)`);
  console.log('='.repeat(62) + '\n');

  if (falhou > 0) {
    console.error('❌ TESTE FALHOU\n');
    process.exit(1);
  }
  console.log('✅ TUDO FUNCIONANDO — rode `npm start` e abra http://localhost:3000\n');
  process.exit(0);
}

main().catch((err) => {
  console.error('\n❌ erro fatal no teste:', err.stack || err.message, '\n');
  process.exit(1);
});
