/**
 * queue.js  (NEW — sistema de fila)
 * ---------------------------------------------------------------------------
 * Fila de trabalhos com DOIS drivers e a MESMA API publica:
 *
 *   1) "bullmq"  -> BullMQ + Redis (producao). Usado automaticamente se o
 *                   Redis responder em REDIS_URL.
 *   2) "memory"  -> Fila em memoria (fallback). Entra em acao sozinha quando
 *                   nao existe Redis, para o projeto rodar com `npm start`
 *                   em qualquer maquina, sem instalar nada.
 *
 * Nos dois casos voce tem:
 *   - concorrencia limitada (config.CONCURRENCY = 2 a 3 videos por vez)
 *   - MELHORIA 2: retry automatico com backoff exponencial (3 tentativas)
 *   - progresso em tempo real (gravado no store -> dashboard)
 *   - aguenta 10+ videos na fila sem travar o servidor
 *
 * API:
 *   await init()            inicia o driver + worker
 *   addVideo({ nicho })     enfileira 1 video            -> { videoId, jobId }
 *   addMany(qtd, nicho)     enfileira N videos (lote)    -> { lote, itens }
 *   await snapshot()        estado da fila para o dashboard
 *   await clear()           limpa fila + registros
 *   await close()           encerra conexoes (graceful shutdown)
 * ---------------------------------------------------------------------------
 */

'use strict';

const crypto = require('crypto');
const config = require('./config');
const store = require('./store');
const orchestrator = require('./orchestrator');

let driver = null;          // 'bullmq' | 'memory'
let bull = null;            // { queue, worker, connection, QueueEvents }
let memory = null;          // instancia da MemoryQueue
let iniciado = false;

/**
 * Corre uma promessa contra o relogio.
 *
 * Com `maxRetriesPerRequest: null` (exigido pelo Worker do BullMQ), o ioredis
 * NAO rejeita quando o Redis cai: ele guarda o comando para quando voltar. Sem
 * um timeout por cima, um `getJobCounts` durante uma queda deixa a requisicao
 * HTTP pendurada e o dashboard inteiro congela.
 */
function comPrazo(promessa, ms, oQue) {
  let timer;
  return Promise.race([
    promessa,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${oQue}: Redis nao respondeu em ${ms}ms`)), ms);
      if (timer.unref) timer.unref();
    }),
  ]).finally(() => clearTimeout(timer));
}

// ===========================================================================
// Processor comum aos dois drivers
// ===========================================================================

/**
 * Executa um job. Recebe um objeto compativel com o Job do BullMQ:
 *   { id, data, attemptsMade, updateProgress(n) }
 */
async function runJob(job) {
  const tentativa = (job.attemptsMade || 0) + 1;
  const { videoId, nicho } = job.data;

  store.updateVideo(videoId, {
    status: 'processing',
    jobId: String(job.id),
    tentativas: tentativa,
    etapa: 'iniciando',
    erro: null,
  });

  console.log(`\n▶️  job ${job.id} | video ${videoId} | nicho ${nicho} | tentativa ${tentativa}/${config.MAX_ATTEMPTS}`);

  const reportProgress = (percent, etapa) => {
    store.updateVideo(videoId, { progresso: percent, etapa });
    // BullMQ: grava o progresso no Redis (nao bloqueia o pipeline se falhar)
    if (typeof job.updateProgress === 'function') {
      Promise.resolve(job.updateProgress(percent)).catch(() => {});
    }
  };

  // Timeout de seguranca: nunca deixa um job preso para sempre.
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`timeout de ${config.JOB_TIMEOUT_MS}ms excedido`)),
      config.JOB_TIMEOUT_MS
    );
  });

  try {
    const resultado = await Promise.race([
      orchestrator.processVideo({ videoId, nicho, lote: job.data.lote }, reportProgress),
      timeout,
    ]);
    return { videoId, titulo: resultado && resultado.titulo };
  } finally {
    clearTimeout(timer);
  }
}

/** Chamado quando as 3 tentativas acabaram (job morreu de vez). */
function marcarFalhaFinal(videoId, erro) {
  store.updateVideo(videoId, {
    status: 'failed',
    etapa: 'falhou',
    erro: String(erro && erro.message ? erro.message : erro),
  });
  console.error(`💀 video ${videoId} falhou depois de ${config.MAX_ATTEMPTS} tentativa(s): ${erro && erro.message}`);
}

function marcarRetry(videoId, tentativa, erro) {
  const esperaMs = config.BACKOFF_MS * Math.pow(2, tentativa - 1);
  store.updateVideo(videoId, {
    status: 'queued',
    etapa: `retry em ${Math.round(esperaMs / 1000)}s`,
    progresso: 0,
    tentativas: tentativa,
    erro: String(erro && erro.message ? erro.message : erro),
  });
  console.warn(`🔁 video ${videoId}: tentativa ${tentativa} falhou, tentando de novo em ${esperaMs}ms`);
}

// ===========================================================================
// Driver 2 — Fila em memoria (fallback sem Redis)
// ===========================================================================

class MemoryQueue {
  constructor({ concurrency, attempts, backoffMs, processor }) {
    this.concurrency = concurrency;
    this.attempts = attempts;
    this.backoffMs = backoffMs;
    this.processor = processor;
    this.pendentes = [];   // jobs aguardando
    this.ativos = new Map(); // id -> job
    this.contador = 0;
    this.finalizados = 0;
    this.falhados = 0;
    this.atrasados = 0;    // jobs aguardando backoff
  }

  add(data) {
    const job = {
      id: `m${++this.contador}`,
      data,
      attemptsMade: 0,
      progress: 0,
      updateProgress(p) { this.progress = p; },
    };
    this.pendentes.push(job);
    // setImmediate: devolve a resposta HTTP antes de comecar o trabalho
    setImmediate(() => this.tick());
    return job;
  }

  tick() {
    while (this.ativos.size < this.concurrency && this.pendentes.length > 0) {
      const job = this.pendentes.shift();
      this.ativos.set(job.id, job);
      this.executar(job);
    }
  }

  async executar(job) {
    try {
      // attemptsMade segue a semantica do BullMQ: numero de tentativas JA
      // feitas antes desta (0 na primeira). Por isso incrementa no catch.
      await this.processor(job);
      this.finalizados += 1;
    } catch (err) {
      job.attemptsMade += 1;
      if (job.attemptsMade < this.attempts) {
        // MELHORIA 2: retry com backoff exponencial
        marcarRetry(job.data.videoId, job.attemptsMade, err);
        const espera = this.backoffMs * Math.pow(2, job.attemptsMade - 1);
        this.atrasados += 1;
        const t = setTimeout(() => {
          this.atrasados -= 1;
          this.pendentes.push(job);
          this.tick();
        }, espera);
        if (t.unref) t.unref();
      } else {
        this.falhados += 1;
        marcarFalhaFinal(job.data.videoId, err);
      }
    } finally {
      this.ativos.delete(job.id);
      this.tick();
    }
  }

  counts() {
    return {
      waiting: this.pendentes.length,
      active: this.ativos.size,
      delayed: this.atrasados,
      completed: this.finalizados,
      failed: this.falhados,
    };
  }

  clear() {
    this.pendentes = [];
    this.finalizados = 0;
    this.falhados = 0;
  }
}

// ===========================================================================
// Driver 1 — BullMQ + Redis
// ===========================================================================

/** Testa se existe Redis acessivel. Nunca lanca excecao. */
async function redisDisponivel() {
  if (!config.USE_REDIS) return false;
  let Redis;
  try {
    Redis = require('ioredis');
  } catch {
    return false;
  }

  const probe = new Redis(config.REDIS_URL, {
    lazyConnect: true,
    connectTimeout: config.REDIS_CONNECT_TIMEOUT_MS,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null, // nao insistir durante a deteccao
    enableOfflineQueue: false,
  });
  probe.on('error', () => {}); // silencia o ruido da deteccao

  try {
    await probe.connect();
    await probe.ping();
    return true;
  } catch {
    return false;
  } finally {
    try { probe.disconnect(); } catch {}
  }
}

async function initBullMQ() {
  const { Queue, Worker } = require('bullmq');
  const IORedis = require('ioredis');

  const connection = new IORedis(config.REDIS_URL, { maxRetriesPerRequest: null });
  connection.on('error', (err) => console.error('[redis] erro:', err.message));

  const queue = new Queue('videos', { connection });

  const worker = new Worker(
    'videos',
    async (job) => runJob(job),
    {
      connection,
      concurrency: config.CONCURRENCY,
      lockDuration: config.JOB_TIMEOUT_MS + 30000,
    }
  );

  worker.on('failed', (job, err) => {
    if (!job) return;
    const tentativa = job.attemptsMade || 1;
    if (tentativa >= config.MAX_ATTEMPTS) marcarFalhaFinal(job.data.videoId, err);
    else marcarRetry(job.data.videoId, tentativa, err);
  });
  worker.on('error', (err) => console.error('[worker] erro:', err.message));

  bull = { queue, worker, connection };
  return bull;
}

// ===========================================================================
// API publica
// ===========================================================================

async function init() {
  if (iniciado) return driver;
  store.ensureDirs();
  await orchestrator.limparTempOrfaos();

  if (await redisDisponivel()) {
    try {
      await initBullMQ();
      driver = 'bullmq';
      console.log(`🧵 fila: BullMQ + Redis (${config.REDIS_URL}) | concorrencia ${config.CONCURRENCY} | ${config.MAX_ATTEMPTS} tentativas`);
    } catch (err) {
      console.error('[queue] BullMQ falhou, caindo para a fila em memoria:', err.message);
      driver = null;
    }
  }

  if (!driver) {
    memory = new MemoryQueue({
      concurrency: config.CONCURRENCY,
      attempts: config.MAX_ATTEMPTS,
      backoffMs: config.BACKOFF_MS,
      processor: runJob,
    });
    driver = 'memory';
    console.log(`🧵 fila: MEMORIA (Redis nao encontrado — tudo funciona, mas a fila nao persiste) | concorrencia ${config.CONCURRENCY} | ${config.MAX_ATTEMPTS} tentativas`);
  }

  // Videos que ficaram "processing" de uma execucao anterior nao tem worker:
  // marca como falha para o dashboard nao mentir.
  for (const v of store.listVideos({ status: 'processing' })) {
    store.updateVideo(v.id, { status: 'failed', etapa: 'interrompido', erro: 'servidor reiniciado durante o processamento' });
  }

  // Mesma honestidade para a fila: se o Redis foi reiniciado sem persistencia,
  // os jobs sumiram mas os registros continuam dizendo "na fila" — e ninguem
  // nunca mais vai processa-los. Confere job a job e marca os orfaos.
  if (driver === 'bullmq') {
    let orfaos = 0;
    for (const v of store.listVideos({ status: 'queued' })) {
      if (!v.jobId) continue;
      try {
        const job = await comPrazo(bull.queue.getJob(v.jobId), config.REDIS_CMD_TIMEOUT_MS, 'conferir job');
        if (!job) {
          store.updateVideo(v.id, { status: 'failed', etapa: 'job perdido', erro: 'a fila foi reiniciada e este trabalho se perdeu' });
          orfaos++;
        }
      } catch (err) {
        console.warn(`[queue] nao consegui conferir o job ${v.jobId}: ${err.message}`);
        break; // Redis fora do ar: nao adianta conferir os outros agora
      }
    }
    if (orfaos) console.warn(`⚠️ ${orfaos} video(s) marcados como perdidos: estavam na fila, mas o job nao existe mais`);
  }

  iniciado = true;
  return driver;
}

/** Enfileira 1 video. */
async function addVideo({ nicho, lote = null, origem = 'manual' } = {}) {
  if (!iniciado) await init();
  const nichoOk = config.resolveNicho(nicho);
  const videoId = orchestrator.novoVideoId();

  store.createVideo({ id: videoId, nicho: nichoOk, lote, origem, status: 'queued', etapa: 'na fila' });

  let jobId;
  if (driver === 'bullmq') {
    let job;
    try {
      job = await comPrazo(
        bull.queue.add(
          'gerar-video',
          { videoId, nicho: nichoOk, lote, origem },
          {
            attempts: config.MAX_ATTEMPTS, // MELHORIA 2
            backoff: { type: 'exponential', delay: config.BACKOFF_MS },
            removeOnComplete: 100,
            removeOnFail: 100,
          }
        ),
        config.REDIS_CMD_TIMEOUT_MS,
        'enfileirar video'
      );
    } catch (err) {
      // Nao deixa um registro fantasma "na fila" que nunca vai rodar.
      store.updateVideo(videoId, { status: 'failed', etapa: 'nao enfileirado', erro: err.message });
      throw new Error(`fila indisponivel: ${err.message}`);
    }
    jobId = String(job.id);
  } else {
    jobId = memory.add({ videoId, nicho: nichoOk, lote, origem }).id;
  }

  store.updateVideo(videoId, { jobId });
  console.log(`➕ enfileirado: video ${videoId} (job ${jobId}, nicho ${nichoOk}${origem === 'auto' ? ', 🤖 automatico' : ''})`);
  return { videoId, jobId, nicho: nichoOk };
}

/** Enfileira N videos de uma vez (MELHORIA 5 aproveita o lote na pesquisa). */
async function addMany(quantidade, nicho) {
  const qtd = Math.max(1, Math.min(Number(quantidade) || 1, 100));
  const lote = `lote_${crypto.randomBytes(3).toString('hex')}`;
  const itens = [];
  for (let i = 0; i < qtd; i++) {
    itens.push(await addVideo({ nicho, lote }));
  }
  console.log(`📦 lote ${lote}: ${itens.length} video(s) na fila (nicho ${config.resolveNicho(nicho)})`);
  return { lote, quantidade: itens.length, itens };
}

/** Contadores do driver ativo. */
async function counts() {
  if (driver === 'bullmq') {
    try {
      const c = await comPrazo(
        bull.queue.getJobCounts('waiting', 'active', 'delayed', 'completed', 'failed'),
        config.REDIS_CMD_TIMEOUT_MS,
        'contadores da fila'
      );
      return {
        waiting: c.waiting || 0,
        active: c.active || 0,
        delayed: c.delayed || 0,
        completed: c.completed || 0,
        failed: c.failed || 0,
        offline: false,
      };
    } catch (err) {
      // Redis fora do ar nao pode derrubar o dashboard: devolve o que da e
      // marca como offline, para a tela avisar em vez de travar.
      return { waiting: 0, active: 0, delayed: 0, completed: 0, failed: 0, offline: true, erro: err.message };
    }
  }
  if (memory) return memory.counts();
  return { waiting: 0, active: 0, delayed: 0, completed: 0, failed: 0 };
}

/**
 * Estado da fila para o dashboard: os trabalhos que ainda estao em andamento
 * (na fila, processando ou em retry) vem do store, que e a fonte da verdade
 * e funciona igual nos dois drivers.
 */
async function snapshot() {
  const ativos = store
    .listVideos({ limit: 500 })
    .filter((v) => v.status === 'queued' || v.status === 'processing')
    .map((v) => ({
      id: v.id,
      jobId: v.jobId,
      nicho: v.nicho,
      status: v.status,
      etapa: v.etapa,
      progresso: v.progresso,
      tentativas: v.tentativas,
      maxTentativas: config.MAX_ATTEMPTS,
      topico: v.topico,
      erro: v.erro,
      lote: v.lote,
      origem: v.origem || 'manual',
      criadoEm: v.criadoEm,
    }))
    .sort((a, b) => (b.status === 'processing' ? 1 : 0) - (a.status === 'processing' ? 1 : 0));

  return {
    driver,
    concorrencia: config.CONCURRENCY,
    maxTentativas: config.MAX_ATTEMPTS,
    contadores: await counts(),
    trabalhos: ativos,
  };
}

async function clear() {
  if (driver === 'bullmq') {
    try {
      await comPrazo(bull.queue.obliterate({ force: true }), config.REDIS_CMD_TIMEOUT_MS, 'limpar fila');
    } catch (err) {
      console.error('[queue] obliterate falhou:', err.message);
    }
  } else if (memory) {
    memory.clear();
  }
  return store.clearAll();
}

async function close() {
  try { if (bull) { await bull.worker.close(); await bull.queue.close(); bull.connection.disconnect(); } } catch {}
  store.flush(true);
  iniciado = false;
}

module.exports = {
  init,
  addVideo,
  addMany,
  snapshot,
  counts,
  clear,
  close,
  get driver() { return driver; },
  // exportado para os testes
  MemoryQueue,
  runJob,
  comPrazo,
};
