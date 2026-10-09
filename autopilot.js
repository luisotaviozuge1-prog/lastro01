/**
 * autopilot.js
 * ---------------------------------------------------------------------------
 * PILOTO AUTOMATICO ("fique ligado")
 *
 * Se ninguem mexer no sistema por X minutos (padrao: 5), em vez de ficar
 * parado o servidor continua trabalhando sozinho: enfileira vídeos novos,
 * alternando entre os nichos, e segue imprimindo um heartbeat no console
 * para você ver que ele esta vivo.
 *
 * O que conta como "alguem mexeu":
 *   - qualquer POST/PUT/PATCH/DELETE na API (gerar, postar, limpar)
 *   - download de arquivo
 *   - ligar/desligar o piloto automatico
 *
 * O que NAO conta (senao o piloto nunca ligaria com a aba aberta):
 *   - o polling do dashboard (GET /api/dashboard a cada 1,5s)
 *
 * Travas de seguranca (para nao lotar o disco sozinho):
 *   - nunca passa de MAX_FILA trabalhos pendentes
 *   - nunca passa de MAX_POR_HORA videos gerados automaticamente
 *   - para na hora em que alguem volta a mexer
 * ---------------------------------------------------------------------------
 */

'use strict';

const config = require('./config');

const cfg = config.AUTOPILOT;

/** "45s", "7 min", "2h13" — para as mensagens do console ficarem legiveis. */
function tempoHumano(ms) {
  const seg = Math.round(ms / 1000);
  if (seg < 60) return `${seg}s`;
  const min = Math.floor(seg / 60);
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)}h${String(min % 60).padStart(2, '0')}`;
}

const estado = {
  ativo: cfg.ATIVO,
  ligadoEm: Date.now(),
  ultimaAtividade: Date.now(),
  ultimoMotivo: 'servidor iniciado',
  geradosAuto: 0,
  ultimoCiclo: null,
  ultimaMensagem: null,
  historico: [], // timestamps dos videos gerados automaticamente (janela de 1h)
};

let timer = null;
let heartbeatTimer = null;
let proximoNicho = 0;
let filaRef = null;

/** Marca que alguem interagiu — zera o cronometro de inatividade. */
function registrarAtividade(motivo = 'interacao') {
  estado.ultimaAtividade = Date.now();
  estado.ultimoMotivo = motivo;
}

/** Middleware do Express: decide o que conta como interacao humana. */
function middleware(req, _res, next) {
  const metodoDeAcao = req.method !== 'GET' && req.method !== 'HEAD';
  const downloadOuThumb = req.path.startsWith('/api/download') || req.path.startsWith('/api/thumb');
  if (metodoDeAcao || downloadOuThumb) {
    registrarAtividade(`${req.method} ${req.path}`);
  }
  next();
}

function inativoMs() {
  return Date.now() - estado.ultimaAtividade;
}

/** Quantos videos o piloto gerou na ultima hora (janela deslizante). */
function geradosNaUltimaHora() {
  const limite = Date.now() - 3600000;
  estado.historico = estado.historico.filter((t) => t > limite);
  return estado.historico.length;
}

/** Alterna os nichos em round-robin para variar o conteudo. */
function proximoNichoRodando() {
  const lista = cfg.NICHOS.length ? cfg.NICHOS : config.NICHOS_LISTA;
  const nicho = lista[proximoNicho % lista.length];
  proximoNicho += 1;
  return nicho;
}

/** Um ciclo de verificacao: gera videos se estiver inativo e houver espaco. */
async function ciclo() {
  estado.ultimoCiclo = new Date().toISOString();
  if (!estado.ativo || !filaRef) return { acao: 'desligado' };

  const inativo = inativoMs();
  if (inativo < cfg.IDLE_MS) return { acao: 'tem gente mexendo' };

  // Trava 1: limite por hora
  const naHora = geradosNaUltimaHora();
  if (naHora >= cfg.MAX_POR_HORA) {
    anunciar(`🤖 piloto automatico em pausa: limite de ${cfg.MAX_POR_HORA} videos/hora atingido`);
    return { acao: 'limite por hora' };
  }

  // Trava 2: nao empilhar trabalho
  const c = await filaRef.counts();
  const pendentes = (c.waiting || 0) + (c.active || 0) + (c.delayed || 0);
  if (pendentes >= cfg.MAX_FILA) return { acao: 'fila cheia' };

  const quantos = Math.max(
    0,
    Math.min(cfg.LOTE, cfg.MAX_FILA - pendentes, cfg.MAX_POR_HORA - naHora)
  );
  if (quantos === 0) return { acao: 'sem espaco' };

  console.log(`\n🤖 PILOTO AUTOMATICO: ${tempoHumano(inativo)} sem ninguem mexer — gerando ${quantos} video(s) sozinho`);

  const criados = [];
  for (let i = 0; i < quantos; i++) {
    try {
      const r = await filaRef.addVideo({ nicho: proximoNichoRodando(), origem: 'auto' });
      estado.historico.push(Date.now());
      estado.geradosAuto += 1;
      criados.push(r.videoId);
    } catch (err) {
      console.error('🤖 piloto automatico falhou ao enfileirar:', err.message);
      break;
    }
  }

  estado.ultimaMensagem = `gerou ${criados.length} video(s) automaticamente apos ${tempoHumano(inativo)} de inatividade`;
  return { acao: 'gerou', criados };
}

function anunciar(msg) {
  if (estado.ultimaMensagem === msg) return; // nao repetir no console
  estado.ultimaMensagem = msg;
  console.log(msg);
}

/** Heartbeat: prova no console de que o servidor continua ligado. */
function heartbeat() {
  const inativo = inativoMs();
  if (inativo < cfg.IDLE_MS) return; // só fala quando esta sozinho
  console.log(
    `💓 ligado · inativo ha ${tempoHumano(inativo)} · piloto automatico ${estado.ativo ? 'LIGADO' : 'desligado'} · ${estado.geradosAuto} video(s) gerado(s) sozinho`
  );
}

/** Liga os timers. `fila` e o modulo queue.js (injetado para facilitar teste). */
function start(fila) {
  filaRef = fila;
  stop();
  timer = setInterval(() => { ciclo().catch((e) => console.error('🤖 erro no piloto:', e.message)); }, cfg.CHECK_MS);
  heartbeatTimer = setInterval(heartbeat, cfg.HEARTBEAT_MS);
  // Nao segurar o processo aberto por causa dos timers
  if (timer.unref) timer.unref();
  if (heartbeatTimer.unref) heartbeatTimer.unref();

  console.log(
    `🤖 piloto automatico: ${estado.ativo ? 'LIGADO' : 'desligado'} — ` +
    `apos ${Math.round(cfg.IDLE_MS / 60000)} min sem ninguem mexer, gera ${cfg.LOTE} video(s) por ciclo ` +
    `(max ${cfg.MAX_FILA} na fila, ${cfg.MAX_POR_HORA}/hora)`
  );
  return estado;
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
}

/** Liga/desliga em runtime (usado pelo botao do dashboard). */
function setAtivo(ativo) {
  estado.ativo = Boolean(ativo);
  registrarAtividade('piloto automatico alterado');
  console.log(`🤖 piloto automatico ${estado.ativo ? 'LIGADO' : 'DESLIGADO'} pelo usuario`);
  return snapshot();
}

/** Estado para o dashboard. */
function snapshot() {
  const inativo = inativoMs();
  return {
    ativo: estado.ativo,
    inativoSegundos: Math.round(inativo / 1000),
    idleLimiteSegundos: Math.round(cfg.IDLE_MS / 1000),
    emAcao: estado.ativo && inativo >= cfg.IDLE_MS,
    geradosAuto: estado.geradosAuto,
    geradosUltimaHora: geradosNaUltimaHora(),
    maxPorHora: cfg.MAX_POR_HORA,
    maxFila: cfg.MAX_FILA,
    loteCiclo: cfg.LOTE,
    ultimaAtividade: new Date(estado.ultimaAtividade).toISOString(),
    ultimoMotivo: estado.ultimoMotivo,
    ultimoCiclo: estado.ultimoCiclo,
    uptimeSegundos: Math.round((Date.now() - estado.ligadoEm) / 1000),
  };
}

module.exports = {
  start,
  stop,
  ciclo,
  heartbeat,
  setAtivo,
  snapshot,
  registrarAtividade,
  middleware,
  estado,
};
