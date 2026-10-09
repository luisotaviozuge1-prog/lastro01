/**
 * orchestrator.js
 * ---------------------------------------------------------------------------
 * O cerebro do sistema: roda os 5 agentes na ordem certa para UM video.
 *
 * Pipeline:
 *
 *   🔍 Pesquisa  ->  ✍️ Roteiro  ->  ┌─ 🎙️ Audio   ─┐ ->  🎬 Edicao
 *                                   └─ 🎨 Imagens ─┘
 *                                    (em PARALELO)
 *
 * MELHORIAS aplicadas aqui:
 *   1) Paralelo: Audio + Imagens ao mesmo tempo (~40% mais rapido)
 *   3) Limpeza de temp: a pasta temporaria do job e apagada no finally
 *   (2 retry fica na fila, 4 anti-repeticao e 5 lote ficam no agents.js)
 * ---------------------------------------------------------------------------
 */

'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

const config = require('./config');
const store = require('./store');
const agents = require('./agents');

/** Pesos de progresso por etapa — somam 100%. */
const PESOS = config.MELHORIAS.PARALELO
  ? { pesquisa: 15, roteiro: 20, midia: 40, edicao: 25 } // audio+imagens juntos
  : { pesquisa: 10, roteiro: 15, audio: 25, imagens: 25, edicao: 25 };

function novoVideoId() {
  return `vid_${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
}

/** Apaga uma pasta inteira sem explodir se ela nao existir (MELHORIA 3). */
async function limparPasta(dir) {
  try {
    await fsp.rm(dir, { recursive: true, force: true });
    return true;
  } catch (err) {
    console.warn(`[orchestrator] nao consegui limpar ${dir}: ${err.message}`);
    return false;
  }
}

/** MELHORIA 3: remove pastas temporarias orfas (ex.: apos um crash). */
async function limparTempOrfaos() {
  if (!config.MELHORIAS.LIMPEZA_TEMP) return 0;
  try {
    store.ensureDirs();
    const entradas = await fsp.readdir(config.PATHS.TEMP, { withFileTypes: true });
    let n = 0;
    for (const e of entradas) {
      if (!e.isDirectory()) continue;
      const dir = path.join(config.PATHS.TEMP, e.name);
      // Só apaga pastas paradas ha mais de 5 min: se outra instancia estiver
      // usando o mesmo DATA_DIR, nao derrubamos o trabalho dela.
      try {
        const info = await fsp.stat(dir);
        if (Date.now() - info.mtimeMs < 5 * 60 * 1000) continue;
      } catch { /* sumiu no meio do caminho, segue */ }
      await limparPasta(dir);
      n++;
    }
    if (n) console.log(`🧹 limpeza inicial: ${n} pasta(s) temporaria(s) removida(s)`);
    return n;
  } catch {
    return 0;
  }
}

/**
 * Processa UM video de ponta a ponta.
 *
 * @param {object}   job            dados do trabalho ({ videoId, nicho, lote })
 * @param {function} reportProgress (percent, etapa, mensagem) => void
 * @returns {object} registro final do video
 */
async function processVideo(job, reportProgress = () => {}) {
  const t0 = Date.now();
  const videoId = job.videoId || novoVideoId();
  const nicho = config.resolveNicho(job.nicho);
  const tempDir = path.join(config.PATHS.TEMP, videoId);

  store.ensureDirs();
  await fsp.mkdir(tempDir, { recursive: true });

  const ctx = { videoId, nicho, tempDir, outputDir: config.PATHS.OUTPUT };
  let progresso = 0;

  const prefixo = `[${videoId}]`;
  const log = (etapa) => (msg) => {
    console.log(`${prefixo} ${msg}`);
    reportProgress(Math.round(progresso), etapa, msg);
  };

  const avancar = (peso, etapa, msg) => {
    progresso = Math.min(100, progresso + peso);
    reportProgress(Math.round(progresso), etapa, msg);
  };

  try {
    store.updateVideo(videoId, { status: 'processing', etapa: 'pesquisa', progresso: 0 });

    // ------------------------------------------------- 1) 🔍 PESQUISA
    Object.assign(ctx, await agents.agentPesquisa(ctx, log('pesquisa')));
    store.updateVideo(videoId, {
      topico: ctx.pesquisa.titulo,
      topicoId: ctx.pesquisa.topicoId,
      viralScore: ctx.pesquisa.viralScore,
    });
    avancar(PESOS.pesquisa, 'pesquisa', 'pesquisa concluida');

    // -------------------------------------------------- 2) ✍️ ROTEIRO
    Object.assign(ctx, await agents.agentRoteiro(ctx, log('roteiro')));
    store.updateVideo(videoId, {
      titulo: ctx.roteiro.titulo,
      script: ctx.roteiro.texto,
      hashtags: ctx.roteiro.hashtags,
      duracao: ctx.roteiro.duracaoEstimada,
    });
    avancar(PESOS.roteiro, 'roteiro', 'roteiro concluido');

    // --------------------------- 3+4) 🎙️ AUDIO + 🎨 IMAGENS (MELHORIA 1)
    if (config.MELHORIAS.PARALELO) {
      console.log(`${prefixo} ⚡ rodando Audio + Imagens em PARALELO`);
      const tMidia = Date.now();
      const [audio, imagens] = await Promise.all([
        agents.agentAudio(ctx, log('audio+imagens')),
        agents.agentImagens(ctx, log('audio+imagens')),
      ]);
      Object.assign(ctx, audio, imagens);
      console.log(`${prefixo} ⚡ midia pronta em ${Date.now() - tMidia}ms (paralelo)`);
      avancar(PESOS.midia, 'audio+imagens', 'audio e imagens prontos');
    } else {
      Object.assign(ctx, await agents.agentAudio(ctx, log('audio')));
      avancar(PESOS.audio, 'audio', 'audio pronto');
      Object.assign(ctx, await agents.agentImagens(ctx, log('imagens')));
      avancar(PESOS.imagens, 'imagens', 'imagens prontas');
    }

    // --------------------------------------------------- 5) 🎬 EDICAO
    Object.assign(ctx, await agents.agentEdicao(ctx, log('edicao')));
    progresso = 100;

    const tempoGeracao = Date.now() - t0;
    const registro = store.updateVideo(videoId, {
      status: 'ready',
      progresso: 100,
      etapa: 'pronto',
      erro: null,
      titulo: ctx.video.titulo,
      duracao: ctx.video.duracao,
      resolucao: ctx.video.resolucao,
      tempoGeracao,
      arquivo: ctx.video.arquivo,
      arquivos: {
        video: ctx.video.arquivo,
        manifesto: ctx.video.manifesto,
        thumbnail: ctx.video.thumbnail,
      },
      descricao: ctx.video.descricao,
      timeline: ctx.video.timeline,
    });

    reportProgress(100, 'pronto', 'video pronto');
    console.log(`${prefixo} 🎉 PRONTO em ${(tempoGeracao / 1000).toFixed(1)}s — ${ctx.video.titulo}`);
    return registro || { id: videoId, status: 'ready' };
  } catch (err) {
    console.error(`${prefixo} ❌ erro no pipeline: ${err.message}`);
    store.updateVideo(videoId, { etapa: 'erro', erro: err.message });
    throw err; // a fila decide se faz retry
  } finally {
    // MELHORIA 3: limpeza de temp sempre, deu certo ou nao.
    if (config.MELHORIAS.LIMPEZA_TEMP) {
      const ok = await limparPasta(tempDir);
      if (ok) console.log(`${prefixo} 🧹 arquivos temporarios removidos`);
    }
  }
}

module.exports = {
  processVideo,
  novoVideoId,
  limparTempOrfaos,
  limparPasta,
  PESOS,
};
