/**
 * render.js
 * ---------------------------------------------------------------------------
 * Renderização REAL com ffmpeg — é o "PLUG AQUI" do Agent Edição implementado.
 *
 * Quando o ffmpeg existe na máquina, o sistema para de escrever placeholder e
 * gera um .mp4 de verdade: 1080x1920, H.264 + AAC, com as cenas em movimento
 * (Ken Burns), transições e a legenda queimada no quadro.
 *
 * Quando NÃO existe, nada quebra: `disponivel()` devolve false e os agentes
 * voltam para o modo simulação. É por isso que `npm install` continua sem
 * dependência nativa nenhuma — o ffmpeg é opcional.
 *
 * Nada aqui lê process.env: toda configuração vem de config.js.
 * ---------------------------------------------------------------------------
 */

'use strict';

const { execFile } = require('child_process');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const config = require('./config');

const cfg = config.RENDER;

/** Executa um binário e devolve stdout. Erro traz o stderr do ffmpeg junto. */
function run(bin, args, timeoutMs = cfg.TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const motivo = String(stderr || err.message).trim().split('\n').slice(-3).join(' | ');
        return reject(new Error(`${path.basename(bin)} falhou: ${motivo}`));
      }
      resolve(String(stdout).trim());
    });
  });
}

// ---------------------------------------------------------------- detecção

let cacheDisponivel = null;
let cacheFonte = null;

/** O ffmpeg está instalado e utilizável? (resultado fica em cache) */
async function disponivel() {
  if (cacheDisponivel !== null) return cacheDisponivel;
  if (!cfg.ATIVO) { cacheDisponivel = false; return false; }
  try {
    await run(cfg.FFMPEG, ['-version'], 10000);
    await run(cfg.FFPROBE, ['-version'], 10000);
    cacheDisponivel = Boolean(await fonte());
  } catch {
    cacheDisponivel = false;
  }
  return cacheDisponivel;
}

/** Acha um arquivo de fonte para o drawtext (sem fonte não há legenda). */
async function fonte() {
  if (cacheFonte !== null) return cacheFonte;
  const candidatas = cfg.FONTE ? [cfg.FONTE, ...cfg.FONTES_PADRAO] : cfg.FONTES_PADRAO;
  for (const f of candidatas) {
    try { await fsp.access(f); cacheFonte = f; return f; } catch { /* próxima */ }
  }
  cacheFonte = null;
  return null;
}

/** Só para os testes: esquece o que foi detectado. */
function limparCache() { cacheDisponivel = null; cacheFonte = null; }

// ---------------------------------------------------------------- utilidades

/** Quebra o texto em linhas de no máximo `max` caracteres (sem cortar palavra). */
function quebrar(texto, max = 26, maxLinhas = 6) {
  const linhas = [];
  let linha = '';
  for (const palavra of String(texto).split(/\s+/).filter(Boolean)) {
    if (linha && (linha + ' ' + palavra).length > max) { linhas.push(linha); linha = palavra; }
    else linha = linha ? `${linha} ${palavra}` : palavra;
  }
  if (linha) linhas.push(linha);
  if (linhas.length > maxLinhas) {
    linhas.length = maxLinhas;
    linhas[maxLinhas - 1] = linhas[maxLinhas - 1].replace(/[,;:]?$/, '...');
  }
  return linhas.join('\n');
}

const hex = (c) => '0x' + String(c).replace('#', '').toUpperCase();

// --------------------------------------------------------- 🎨 imagem da cena

/**
 * Gera o PNG 1080x1920 de uma cena: gradiente + sombra + legenda + marcação.
 * Os textos vão por arquivo (`textfile`) para não haver escape de `:` e `'`.
 */
async function imagemCena({ arquivo, tempDir, titulo, legenda, indice, total, cores }) {
  const f = await fonte();
  const base = path.join(tempDir, `txt-${indice}`);
  const arqLegenda = `${base}-legenda.txt`;
  const arqTitulo = `${base}-titulo.txt`;
  const arqMarca = `${base}-marca.txt`;

  await fsp.writeFile(arqLegenda, quebrar(legenda, 24), 'utf8');
  await fsp.writeFile(arqTitulo, quebrar(titulo, 34, 2), 'utf8');
  await fsp.writeFile(arqMarca, `cena ${indice}/${total}`, 'utf8');

  const { WIDTH: W, HEIGHT: H } = config.VIDEO;
  // O ângulo do gradiente muda por cena para o vídeo não ficar chapado.
  const desloc = (indice % 2 === 0) ? Math.round(W * 0.2) : 0;

  const vf = [
    `drawbox=y=ih*0.46:w=iw:h=ih*0.54:color=black@0.46:t=fill`,
    `drawtext=fontfile=${f}:textfile=${arqTitulo}:fontsize=42:fontcolor=white@0.82:line_spacing=10:x=(w-text_w)/2:y=150`,
    `drawtext=fontfile=${f}:textfile=${arqLegenda}:fontsize=66:fontcolor=white:line_spacing=18:x=(w-text_w)/2:y=h*0.56`,
    `drawtext=fontfile=${f}:textfile=${arqMarca}:fontsize=36:fontcolor=white@0.65:x=(w-text_w)/2:y=h-140`,
  ].join(',');

  await run(cfg.FFMPEG, [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi',
    '-i', `gradients=s=${W}x${H}:c0=${hex(cores[0])}:c1=${hex(cores[1])}:x0=${desloc}:y0=0:x1=${W - desloc}:y1=${H}:nb_colors=2:d=1`,
    '-frames:v', '1',
    '-vf', vf,
    arquivo,
  ]);

  return arquivo;
}

// ------------------------------------------------------------- 🎙️ narração

/**
 * Gera a faixa de áudio com a duração do roteiro.
 *
 * Se `config.RENDER.TTS_CMD` estiver definido, ele é usado para sintetizar a
 * voz de verdade (ex.: "espeak-ng -v pt-br -w {saida} -f {texto}").
 * Sem TTS configurado, gera silêncio — o vídeo sai assistível e a narração
 * fica como o próximo plugue óbvio.
 */
async function faixaAudio({ arquivo, duracao, texto, tempDir }) {
  if (cfg.TTS_CMD) {
    const arqTexto = path.join(tempDir, 'narracao.txt');
    await fsp.writeFile(arqTexto, texto, 'utf8');
    const bruto = path.join(tempDir, 'tts.wav');
    const partes = cfg.TTS_CMD
      .replace(/\{texto\}/g, arqTexto)
      .replace(/\{saida\}/g, bruto)
      .split(/\s+/);
    await run(partes[0], partes.slice(1));
    await run(cfg.FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', '-i', bruto,
      '-c:a', 'aac', '-b:a', '128k', arquivo]);
    return { arquivo, voz: 'TTS externo', simulado: false, silencio: false };
  }

  await run(cfg.FFMPEG, [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100',
    '-t', String(duracao),
    '-c:a', 'aac', '-b:a', '128k',
    arquivo,
  ]);
  return { arquivo, voz: 'sem TTS (faixa silenciosa)', simulado: false, silencio: true };
}

// ----------------------------------------------------------------- 🎬 vídeo

/**
 * Monta o .mp4 final: um segmento por cena com Ken Burns e fade, concatenados
 * e muxados com o áudio.
 */
async function montarVideo({ saida, tempDir, cenas, audio, duracaoTotal }) {
  const { WIDTH: W, HEIGHT: H, FPS } = config.VIDEO;
  const segmentos = [];

  for (const cena of cenas) {
    const seg = path.join(tempDir, `seg-${cena.indice}.mp4`);
    const d = Math.max(1.2, Number(cena.duracao) || 2);
    const fade = Math.min(0.4, d / 4);
    // `-framerate` na ENTRADA é obrigatório: sem ele o -loop entra a 25fps e o
    // zoompan (1 quadro de saída por quadro de entrada) encurta o segmento.
    await run(cfg.FFMPEG, [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-loop', '1', '-framerate', String(FPS), '-t', d.toFixed(2), '-i', cena.imagem,
      '-vf', [
        `scale=${Math.round(W * 1.2)}:${Math.round(H * 1.2)}`,
        `zoompan=z='min(1.0+0.0009*on,1.12)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${W}x${H}:fps=${FPS}`,
        `fade=t=in:st=0:d=${fade.toFixed(2)}`,
        `fade=t=out:st=${(d - fade).toFixed(2)}:d=${fade.toFixed(2)}`,
        'format=yuv420p',
      ].join(','),
      '-c:v', 'libx264', '-preset', cfg.PRESET, '-crf', String(cfg.CRF), '-r', String(FPS),
      seg,
    ]);
    segmentos.push(seg);
  }

  const lista = path.join(tempDir, 'segmentos.txt');
  await fsp.writeFile(lista, segmentos.map((s) => `file '${s}'`).join('\n'), 'utf8');
  const mudo = path.join(tempDir, 'sem-audio.mp4');
  await run(cfg.FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'concat', '-safe', '0', '-i', lista, '-c', 'copy', mudo]);

  await run(cfg.FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error',
    '-i', mudo, '-i', audio,
    '-c:v', 'copy', '-c:a', 'copy', '-shortest',
    '-movflags', '+faststart', // começa a tocar antes de baixar tudo
    saida]);

  return saida;
}

// ------------------------------------------------------------------ ffprobe

/** Lê os dados reais do arquivo gerado (não confie no que você pediu). */
async function inspecionar(arquivo) {
  const saida = await run(cfg.FFPROBE, [
    '-v', 'error',
    '-show_entries', 'format=duration,size:stream=codec_type,codec_name,width,height',
    '-of', 'json', arquivo,
  ], 20000);
  const dados = JSON.parse(saida);
  const video = (dados.streams || []).find((s) => s.codec_type === 'video') || {};
  const som = (dados.streams || []).find((s) => s.codec_type === 'audio') || {};
  return {
    duracao: Number(Number(dados.format.duration).toFixed(2)),
    bytes: Number(dados.format.size),
    largura: video.width || null,
    altura: video.height || null,
    codecVideo: video.codec_name || null,
    codecAudio: som.codec_name || null,
    temAudio: Boolean(som.codec_name),
  };
}

module.exports = {
  disponivel,
  fonte,
  limparCache,
  quebrar,
  imagemCena,
  faixaAudio,
  montarVideo,
  inspecionar,
};
