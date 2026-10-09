/**
 * config.js
 * ---------------------------------------------------------------------------
 * Toda a configuracao do sistema em um unico lugar.
 * Tudo pode ser sobrescrito por variaveis de ambiente (.env / export).
 * ---------------------------------------------------------------------------
 */

'use strict';

const path = require('path');

// Helpers para ler env vars com valor padrao -------------------------------
const num = (v, def) => (v === undefined || v === '' || isNaN(Number(v)) ? def : Number(v));
const bool = (v, def) => (v === undefined || v === '' ? def : /^(1|true|yes|on)$/i.test(String(v)));

const ROOT = __dirname;
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');

const config = {
  // ---------------------------------------------------------------- servidor
  PORT: num(process.env.PORT, 3000),
  HOST: process.env.HOST || '0.0.0.0',

  // -------------------------------------------------------------------- fila
  // Se o Redis estiver disponivel usamos BullMQ. Caso contrario o sistema cai
  // automaticamente para a fila em memoria (mesma API) — nada travar.
  REDIS_URL: process.env.REDIS_URL || 'redis://127.0.0.1:6379',
  USE_REDIS: bool(process.env.USE_REDIS, true),
  REDIS_CONNECT_TIMEOUT_MS: num(process.env.REDIS_CONNECT_TIMEOUT_MS, 1500),

  // Maximo de videos processando ao mesmo tempo (2-3 e o ideal)
  CONCURRENCY: Math.max(1, Math.min(num(process.env.CONCURRENCY, 2), 5)),
  // Retry automatico: 3 tentativas no total
  MAX_ATTEMPTS: num(process.env.MAX_ATTEMPTS, 3),
  // Backoff exponencial entre tentativas (1s, 2s, 4s...)
  BACKOFF_MS: num(process.env.BACKOFF_MS, 1000),
  // Timeout de seguranca por video (evita job preso para sempre)
  JOB_TIMEOUT_MS: num(process.env.JOB_TIMEOUT_MS, 180000),

  // ------------------------------------------------------------------ caminhos
  PATHS: {
    ROOT,
    DATA: DATA_DIR,
    OUTPUT: path.join(DATA_DIR, 'output'),
    TEMP: path.join(DATA_DIR, 'temp'),
    DB: path.join(DATA_DIR, 'videos.json'),
  },

  // -------------------------------------------------------------------- video
  VIDEO: {
    WIDTH: 1080,
    HEIGHT: 1920, // vertical — Shorts / Reels / TikTok
    FPS: 30,
    MIN_DURATION: 20, // segundos
    MAX_DURATION: 30,
    FORMAT: 'mp4',
    IMAGES_PER_VIDEO: num(process.env.IMAGES_PER_VIDEO, 4),
    WORDS_PER_SECOND: 2.6, // ritmo de narracao usado para estimar duracao
  },

  // ------------------------------------------------------------------- nichos
  NICHOS: {
    'gta6': {
      label: 'GTA 6',
      emoji: '🎮',
      hashtags: ['#gta6', '#gta', '#rockstar', '#shorts', '#games'],
      voice: 'pt-BR-Hype-Male',
    },
    'curiosidades-games': {
      label: 'Curiosidades de Games',
      emoji: '🤯',
      hashtags: ['#curiosidades', '#games', '#gamer', '#shorts'],
      voice: 'pt-BR-Narrator-Female',
    },
    'dicas-gameplay': {
      label: 'Dicas de Gameplay',
      emoji: '🕹️',
      hashtags: ['#dicas', '#gameplay', '#tutorial', '#shorts'],
      voice: 'pt-BR-Coach-Male',
    },
    'easter-eggs': {
      label: 'Easter Eggs',
      emoji: '🥚',
      hashtags: ['#easteregg', '#segredos', '#games', '#shorts'],
      voice: 'pt-BR-Mystery-Male',
    },
  },
  NICHO_DEFAULT: process.env.NICHO_DEFAULT || 'gta6',

  // -------------------------------------------------------- 5 melhorias extras
  MELHORIAS: {
    // 1) Audio e Imagens rodam em paralelo (~40% mais rapido)
    PARALELO: bool(process.env.MELHORIA_PARALELO, true),
    // 2) Retry automatico (ver MAX_ATTEMPTS)
    RETRY: bool(process.env.MELHORIA_RETRY, true),
    // 3) Limpeza automatica dos arquivos temporarios
    LIMPEZA_TEMP: bool(process.env.MELHORIA_LIMPEZA, true),
    // 4) Anti-repeticao: nao repetir topico usado nos ultimos N videos
    ANTI_REPETICAO: bool(process.env.MELHORIA_ANTI_REPETICAO, true),
    ANTI_REPETICAO_JANELA: num(process.env.ANTI_REPETICAO_JANELA, 10),
    // 5) Agrupamento em lote: 1 pesquisa serve varios videos do mesmo nicho
    LOTE_PESQUISA: bool(process.env.MELHORIA_LOTE, true),
    LOTE_TAMANHO: num(process.env.LOTE_TAMANHO, 12),
    LOTE_TTL_MS: num(process.env.LOTE_TTL_MS, 5 * 60 * 1000),
  },

  // ---------------------------------------------- renderizacao real (ffmpeg)
  // Se o ffmpeg existir na maquina, o Agent Edicao gera um .mp4 DE VERDADE.
  // Se nao existir, cai sozinho no placeholder e nada quebra.
  RENDER: {
    ATIVO: bool(process.env.RENDER_REAL, true),
    FFMPEG: process.env.FFMPEG_BIN || 'ffmpeg',
    FFPROBE: process.env.FFPROBE_BIN || 'ffprobe',
    CRF: num(process.env.RENDER_CRF, 23),       // qualidade (menor = melhor)
    PRESET: process.env.RENDER_PRESET || 'veryfast',
    TIMEOUT_MS: num(process.env.RENDER_TIMEOUT_MS, 120000),
    // Fonte da legenda queimada no quadro
    FONTE: process.env.RENDER_FONTE || null,
    FONTES_PADRAO: [
      '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
      '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf',
      '/usr/share/fonts/truetype/freefont/FreeSansBold.ttf',
      '/System/Library/Fonts/Supplemental/Arial Bold.ttf',
      'C:/Windows/Fonts/arialbd.ttf',
    ],
    // Narracao real: comando de TTS com {texto} (arquivo de entrada) e
    // {saida} (wav gerado). Ex.: "espeak-ng -v pt-br -w {saida} -f {texto}"
    TTS_CMD: process.env.TTS_CMD || null,
  },

  // ----------------------------------------------------------------- simulacao
  // Enquanto nao existem APIs externas plugadas, os agentes simulam dados
  // realistas (latencia, arquivos em disco, metadados).
  SIMULACAO: {
    ATIVA: bool(process.env.SIMULACAO, true),
    // Multiplicador de velocidade: 1 = tempo "real", 0.2 = 5x mais rapido
    VELOCIDADE: num(process.env.SIM_SPEED, 1),
    // Taxa de falha artificial por agente (0 a 1) — use 0.2 para ver o retry
    FAIL_RATE: Math.max(0, Math.min(num(process.env.AGENT_FAIL_RATE, 0), 1)),
  },

  // ------------------------------------------------ piloto automatico ("fique ligado")
  // Se ninguem mexer por IDLE_MS, o sistema continua gerando video sozinho.
  AUTOPILOT: {
    ATIVO: bool(process.env.AUTO_PILOT, true),
    // 5 minutos sem ninguem mexer -> o piloto assume
    IDLE_MS: num(process.env.AUTO_PILOT_IDLE_MS, 5 * 60 * 1000),
    // de quanto em quanto tempo ele verifica
    CHECK_MS: num(process.env.AUTO_PILOT_CHECK_MS, 30 * 1000),
    // quantos videos ele enfileira por ciclo
    LOTE: num(process.env.AUTO_PILOT_LOTE, 2),
    // travas de seguranca
    MAX_FILA: num(process.env.AUTO_PILOT_MAX_FILA, 4),
    MAX_POR_HORA: num(process.env.AUTO_PILOT_MAX_POR_HORA, 20),
    // batimento no console provando que esta ligado
    HEARTBEAT_MS: num(process.env.AUTO_PILOT_HEARTBEAT_MS, 60 * 1000),
    // nichos que o piloto usa (alternando). vazio = todos
    NICHOS: (process.env.AUTO_PILOT_NICHOS || '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  },

  // -------------------------------------------------------------- publicacao
  YOUTUBE: {
    SIMULADO: bool(process.env.YOUTUBE_SIMULADO, true),
    CANAL: process.env.YOUTUBE_CANAL || 'Viral Shorts BR',
  },
};

config.NICHOS_LISTA = Object.keys(config.NICHOS);

/** Valida um nicho recebido via API; cai no default se for invalido. */
config.resolveNicho = function resolveNicho(nicho) {
  const key = String(nicho || '').trim().toLowerCase();
  return config.NICHOS[key] ? key : config.NICHO_DEFAULT;
};

module.exports = config;
