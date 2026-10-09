/**
 * store.js
 * ---------------------------------------------------------------------------
 * Persistencia simples em JSON (data/videos.json).
 *
 * Por que JSON e nao SQLite? Porque `npm install` precisa funcionar sem
 * compilador nativo em qualquer maquina. A API abaixo e sincrona e pequena,
 * trocar por SQLite/Postgres depois e so reimplementar estas funcoes.
 * ---------------------------------------------------------------------------
 */

'use strict';

const fs = require('fs');
const path = require('path');
const config = require('./config');

const DB_FILE = config.PATHS.DB;

/** Estado em memoria (fonte da verdade) + flush em disco debounced. */
let state = { videos: [], counters: { apiCallsSaved: 0, totalGerados: 0 } };
let flushTimer = null;
let loaded = false;

function ensureDirs() {
  for (const dir of [config.PATHS.DATA, config.PATHS.OUTPUT, config.PATHS.TEMP]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function load() {
  if (loaded) return state;
  ensureDirs();
  try {
    if (fs.existsSync(DB_FILE)) {
      const raw = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
      state = {
        videos: Array.isArray(raw.videos) ? raw.videos : [],
        counters: Object.assign({ apiCallsSaved: 0, totalGerados: 0 }, raw.counters),
      };
    }
  } catch (err) {
    // Banco corrompido nao deve derrubar o servidor: avisa e comeca limpo.
    console.error('[store] videos.json invalido, iniciando banco novo:', err.message);
    state = { videos: [], counters: { apiCallsSaved: 0, totalGerados: 0 } };
  }
  loaded = true;
  return state;
}

function flush(immediate = false) {
  if (immediate) {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    ensureDirs();
    fs.writeFileSync(DB_FILE, JSON.stringify(state, null, 2));
    return;
  }
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    try {
      ensureDirs();
      fs.writeFileSync(DB_FILE, JSON.stringify(state, null, 2));
    } catch (err) {
      console.error('[store] falha ao salvar:', err.message);
    }
  }, 150);
  if (flushTimer.unref) flushTimer.unref();
}

// --------------------------------------------------------------------- CRUD

/** Cria o registro do video no momento em que ele entra na fila. */
function createVideo(data) {
  load();
  const video = Object.assign(
    {
      id: data.id,
      jobId: data.jobId || null,
      nicho: data.nicho,
      titulo: null,
      topico: null,
      topicoId: null,
      status: 'queued', // queued | processing | ready | posted | failed
      progresso: 0,
      etapa: 'na fila',
      tentativas: 0,
      erro: null,
      duracao: null,       // duracao do video em segundos
      tempoGeracao: null,  // quanto tempo levou para gerar (ms)
      arquivo: null,
      arquivos: null,
      script: null,
      hashtags: null,
      youtube: null,
      criadoEm: new Date().toISOString(),
      atualizadoEm: new Date().toISOString(),
      lote: data.lote || null,
    },
    data
  );
  state.videos.unshift(video);
  state.counters.totalGerados += 1;
  flush();
  return video;
}

function getVideo(id) {
  load();
  return state.videos.find((v) => v.id === id) || null;
}

/** Atualiza campos de um video (merge raso) e devolve o registro novo. */
function updateVideo(id, patch) {
  load();
  const video = getVideo(id);
  if (!video) return null;
  Object.assign(video, patch, { atualizadoEm: new Date().toISOString() });
  flush();
  return video;
}

function listVideos({ status, nicho, limit = 200 } = {}) {
  load();
  return state.videos
    .filter((v) => (status ? v.status === status : true))
    .filter((v) => (nicho ? v.nicho === nicho : true))
    .slice(0, limit);
}

function removeVideo(id) {
  load();
  const i = state.videos.findIndex((v) => v.id === id);
  if (i === -1) return false;
  state.videos.splice(i, 1);
  flush();
  return true;
}

function clearAll() {
  load();
  const n = state.videos.length;
  state.videos = [];
  flush(true);
  return n;
}

// ------------------------------------------- MELHORIA 4: anti-repeticao

/**
 * Retorna os topicos usados nos ultimos N videos (qualquer status != failed).
 * O Agent de Pesquisa usa essa lista para nao repetir assunto.
 */
function recentTopicIds(janela = config.MELHORIAS.ANTI_REPETICAO_JANELA, nicho = null) {
  load();
  return state.videos
    .filter((v) => v.status !== 'failed')
    .filter((v) => (nicho ? v.nicho === nicho : true))
    .slice(0, janela)
    .map((v) => v.topicoId)
    .filter(Boolean);
}

// ------------------------------------------------------------- estatisticas

function countApiCallSaved(n = 1) {
  load();
  state.counters.apiCallsSaved += n;
  flush();
}

function stats() {
  load();
  const byStatus = { queued: 0, processing: 0, ready: 0, posted: 0, failed: 0 };
  const byNicho = {};
  let somaTempo = 0;
  let comTempo = 0;

  for (const v of state.videos) {
    byStatus[v.status] = (byStatus[v.status] || 0) + 1;
    byNicho[v.nicho] = (byNicho[v.nicho] || 0) + 1;
    if (v.tempoGeracao) { somaTempo += v.tempoGeracao; comTempo += 1; }
  }

  return {
    total: state.videos.length,
    ...byStatus,
    porNicho: byNicho,
    tempoMedioMs: comTempo ? Math.round(somaTempo / comTempo) : null,
    apiCallsEconomizadas: state.counters.apiCallsSaved,
    totalGeradosHistorico: state.counters.totalGerados,
  };
}

module.exports = {
  ensureDirs,
  load,
  flush,
  createVideo,
  getVideo,
  updateVideo,
  listVideos,
  removeVideo,
  clearAll,
  recentTopicIds,
  countApiCallSaved,
  stats,
};
