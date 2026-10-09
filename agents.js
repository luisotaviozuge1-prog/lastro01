/**
 * agents.js
 * ---------------------------------------------------------------------------
 * Os 5 agentes especializados do pipeline:
 *
 *   🔍 agentPesquisa  -> acha o topico viral (com anti-repeticao + lote)
 *   ✍️ agentRoteiro   -> escreve o script de 20-30s
 *   🎙️ agentAudio     -> gera a narracao
 *   🎨 agentImagens    -> gera/busca os visuais 1080x1920
 *   🎬 agentEdicao     -> monta o video final
 *
 * Todos os agentes seguem a mesma assinatura:
 *
 *   await agentX(ctx, log)
 *
 *   ctx = { videoId, nicho, tempDir, outputDir, ...dados dos agentes anteriores }
 *   log = (mensagem) => void   (para progresso em tempo real)
 *
 * MODO SIMULACAO: nenhuma API externa e necessaria. Os agentes geram dados
 * realistas e escrevem arquivos de verdade no disco. Cada agente tem um
 * comentario "PLUG AQUI" mostrando onde entra a API real depois.
 * ---------------------------------------------------------------------------
 */

'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const config = require('./config');
const store = require('./store');
const render = require('./render');

// ===========================================================================
// Utilitarios
// ===========================================================================

const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

/** Espera um tempo "realista" respeitando o multiplicador de velocidade. */
function trabalhar(msMin, msMax) {
  const ms = msMin + Math.random() * (msMax - msMin);
  return sleep(ms * config.SIMULACAO.VELOCIDADE);
}

/** Falha artificial para testar o retry (AGENT_FAIL_RATE=0.2 por exemplo). */
function talvezFalhar(agente) {
  if (config.SIMULACAO.FAIL_RATE > 0 && Math.random() < config.SIMULACAO.FAIL_RATE) {
    throw new Error(`[${agente}] falha simulada (AGENT_FAIL_RATE=${config.SIMULACAO.FAIL_RATE})`);
  }
}

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const slug = (s) =>
  String(s)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 60);

function contarPalavras(texto) {
  return String(texto).trim().split(/\s+/).filter(Boolean).length;
}

/** Estima a duracao da narracao a partir do numero de palavras. */
function estimarDuracao(texto) {
  return Number((contarPalavras(texto) / config.VIDEO.WORDS_PER_SECOND).toFixed(1));
}

// ===========================================================================
// Base de conteudo por nicho (simula o retorno de uma API de tendencias)
// ===========================================================================

const BASE_CONTEUDO = {
  'gta6': [
    { t: 'O trailer de GTA 6 bateu recorde no YouTube', f: 'o primeiro trailer passou de 90 milhoes de views em 24 horas e virou o lancamento mais assistido da historia do YouTube fora da musica' },
    { t: 'Vice City esta de volta', f: 'o mapa volta para a Leonida inspirada na Florida, o maior mapa ja feito pela Rockstar' },
    { t: 'A primeira protagonista mulher da serie', f: 'Lucia e a primeira protagonista feminina jogavel da serie principal, e a dupla com Jason foi inspirada em Bonnie e Clyde' },
    { t: 'Dez anos de producao', f: 'a producao passou de uma decada e o orcamento estimado faz de GTA 6 o jogo mais caro ja produzido' },
    { t: 'A agua de GTA 6 tem fisica propria', f: 'as ondas reagem ao vento e os barcos deixam rastro na agua em tempo real, algo que nenhum GTA anterior tinha' },
    { t: 'NPCs com rotina de 24 horas', f: 'cada NPC tem uma rotina propria: trabalha, volta pra casa e reage ao seu historico de crimes na regiao' },
    { t: 'O mapa muda com o tempo', f: 'lojas abrem e fecham, obras avancam e furacoes mudam o cenario conforme o jogo avanca' },
    { t: 'GTA 6 e o lancamento mais esperado da decada', f: 'analistas apontam que o jogo pode vender mais de 40 milhoes de copias so no primeiro ano' },
    { t: 'O radio de GTA 6 tem licenciamento recorde', f: 'a Rockstar negociou centenas de musicas e algumas faixas foram feitas exclusivamente para o jogo' },
    { t: 'Policia com memoria', f: 'a policia agora lembra do seu rosto: se voce for visto, os postos de bloqueio aparecem antes de voce chegar' },
    { t: 'A Rockstar escondeu pistas no proprio site', f: 'fas acharam metadados e nomes de arquivo no site oficial que confirmaram locais do mapa meses antes do anuncio' },
    { t: 'Online desde o primeiro dia', f: 'o modo online foi pensado junto com a campanha, e nao adicionado depois como no GTA 5' },
  ],
  'curiosidades-games': [
    { t: 'O cogumelo do Mario nasceu de um limite tecnico', f: 'o Mario ficou grande com o cogumelo porque o NES nao tinha memoria para dois personagens diferentes' },
    { t: 'As nuvens e os arbustos do Mario sao iguais', f: 'os arbustos de Super Mario Bros sao as mesmas nuvens pintadas de verde, para economizar memoria do cartucho' },
    { t: 'Pac-Man foi inspirado numa pizza', f: 'o criador Toru Iwatani tirou a ideia do formato de uma pizza com uma fatia faltando' },
    { t: 'O nome Sonic quase foi outro', f: 'o mascote da Sega quase se chamou Mr. Needlemouse antes de virar Sonic the Hedgehog' },
    { t: 'Minecraft foi feito em uma semana', f: 'a primeira versao jogavel foi programada por Notch em cerca de 6 dias em 2009' },
    { t: 'O Konami Code tem quase 40 anos', f: 'cima cima baixo baixo esquerda direita esquerda direita B A foi criado porque o programador nao conseguia terminar o proprio jogo' },
    { t: 'Tetris foi feito em um computador sovietico', f: 'Alexey Pajitnov criou Tetris em 1984 num Electronika 60, que nem tinha graficos: as pecas eram feitas de parenteses' },
    { t: 'O primeiro easter egg virou protesto', f: 'o programador de Adventure escondeu o proprio nome no jogo porque a Atari nao dava credito aos desenvolvedores' },
    { t: 'A trilha de Halo foi gravada em 3 dias', f: 'o tema com os monges foi composto e gravado em menos de uma semana e virou uma das trilhas mais reconhecidas dos games' },
    { t: 'Street Fighter 2 criou o combo por acidente', f: 'o sistema de combos era um bug de cancelamento de animacao que os jogadores descobriram e a Capcom decidiu manter' },
    { t: 'O silencio de Gordon Freeman e proposital', f: 'o protagonista de Half-Life nunca fala para que o jogador sinta que e ele mesmo dentro de Black Mesa' },
    { t: 'Doom roda em praticamente tudo', f: 'Doom de 1993 ja foi rodado em calculadoras, caixas eletronicos, geladeiras e até em testes de gravidez modificados' },
  ],
  'dicas-gameplay': [
    { t: 'Baixe a sensibilidade para acertar mais', f: 'a maioria dos jogadores de FPS usa sensibilidade alta demais; baixar 20% melhora o controle de recuo em poucos dias de treino' },
    { t: 'Use som antes da mira', f: 'em jogos competitivos o audio entrega a posicao do inimigo antes do visual, então fone fechado vale mais que mouse caro' },
    { t: 'Treine 10 minutos antes de jogar ranqueada', f: 'aquecer a mira por 10 minutos aumenta a precisao media na primeira partida de forma mensuravel' },
    { t: 'Fique no centro do mapa', f: 'controlar o centro do mapa da mais rotas de fuga e reduz a chance de ser pego por tras' },
    { t: 'Recarregue andando', f: 'quase todo shooter moderno permite recarregar em movimento, parar para recarregar e o erro mais comum de quem esta subindo de rank' },
    { t: 'Jogue com FOV maior', f: 'aumentar o campo de visao mostra inimigos pela periferia da tela e reduz emboscadas laterais' },
    { t: 'Desligue o motion blur', f: 'tirar o motion blur deixa a imagem mais nitida em movimento e ajuda a rastrear alvos rapidos' },
    { t: 'Aprenda um mapa por semana', f: 'focar em um mapa por vez da resultado mais rapido do que tentar decorar todos ao mesmo tempo' },
    { t: 'Use o minimapa a cada 5 segundos', f: 'olhar o minimapa com frequencia e o habito que mais separa jogador mediano de jogador bom' },
    { t: 'Nao lute com desvantagem de numero', f: 'recuar em 1 contra 2 e matematicamente melhor que trocar tiro: voce perde o round, nao a partida' },
    { t: 'Configure o FPS acima do refresh', f: 'manter o FPS estavel acima da taxa do monitor reduz o input lag percebido mesmo sem monitor gamer' },
    { t: 'Grave suas partidas', f: 'rever 10 minutos da sua propria gameplay encontra mais erros do que assistir horas de profissional' },
  ],
  'easter-eggs': [
    { t: 'O fantasma do Monte Chiliad', f: 'em GTA 5 existe o fantasma de Jolene Cranley-Evans que aparece no Monte Chiliad entre 23h e 0h' },
    { t: 'A sala secreta do Skyrim', f: 'existe uma sala de desenvolvedor em Skyrim com todos os itens do jogo, acessivel so por comando de console' },
    { t: 'O quarto do bebe em Resident Evil', f: 'a mansao de Resident Evil esconde documentos que so aparecem no modo dificil e mudam a leitura da historia' },
    { t: 'O carro voador de Mario Kart', f: 'em varios Mario Kart existem atalhos que so funcionam com cogumelo no momento exato, usados por speedrunners' },
    { t: 'O alien congelado de GTA 5', f: 'sob o gelo no norte do mapa de GTA 5 existe um alienigena congelado que so aparece no prologo do jogo' },
    { t: 'A mensagem escondida no Portal', f: 'os radios de Portal, se levados para pontos especificos, tocam sinais que viraram a pista do anuncio de Portal 2' },
    { t: 'O trator secreto de Red Dead', f: 'ha varios locais em Red Dead Redemption 2 com referencias a GTA, incluindo nomes de ruas e marcas' },
    { t: 'A piada do desenvolvedor no Minecraft', f: 'a tela de carregamento do Minecraft mostra frases aleatorias, e algumas sao piadas internas dos desenvolvedores desde 2009' },
    { t: 'O quarto 404 do Hitman', f: 'varios mapas de Hitman escondem referencias a jogos antigos da serie em numeros de quarto e placas' },
    { t: 'O codigo morse de Battlefield', f: 'Battlefield 4 esconde um codigo morse numa ilha que destravou um easter egg coletivo da comunidade' },
    { t: 'A tumba do desenvolvedor em Elden Ring', f: 'areas de Elden Ring guardam homenagens e itens que fazem referencia direta a Dark Souls' },
    { t: 'O cachorro invisivel de Duck Hunt', f: 'o cachorro de Duck Hunt e jogavel no modo 2 jogadores: o segundo controle move o cachorro' },
  ],
};

// ===========================================================================
// MELHORIA 5 — Agrupamento em lote das pesquisas
// ---------------------------------------------------------------------------
// Em vez de 1 chamada de API por video, fazemos 1 chamada por nicho que traz
// um lote de topicos e fica em cache. Os videos seguintes do mesmo nicho
// consomem o cache -> economia direta de API.
// ===========================================================================

const cacheLotes = new Map(); // nicho -> { topicos: [], criadoEm, consumidos }

/** Angulos usados quando o lote de topicos se esgota (MELHORIA 4). */
const ANGULOS = [
  'o que ninguem te contou',
  'a parte 2 da historia',
  'o detalhe que passou batido',
  'por que isso ainda importa',
];

function loteValido(lote) {
  return lote && Date.now() - lote.criadoEm < config.MELHORIAS.LOTE_TTL_MS && lote.topicos.length > 0;
}

/** Simula a chamada de API de tendencias e devolve um LOTE de topicos. */
async function buscarLote(nicho, log) {
  // PLUG AQUI: Google Trends / Reddit API / YouTube Data API / NewsAPI.
  await trabalhar(500, 1100);
  const base = BASE_CONTEUDO[nicho] || BASE_CONTEUDO[config.NICHO_DEFAULT];
  const topicos = base
    .map((item) => ({
      id: slug(item.t),
      titulo: item.t,
      fato: item.f,
      nicho,
      fonte: pick(['google-trends', 'reddit/r/gaming', 'youtube-trending', 'x-trending']),
      viralScore: Number((6.5 + Math.random() * 3.5).toFixed(1)), // 6.5 - 10
    }))
    .sort((a, b) => b.viralScore - a.viralScore)
    .slice(0, config.MELHORIAS.LOTE_TAMANHO);

  log(`lote de ${topicos.length} topicos buscado para "${nicho}" (1 chamada de API)`);
  return { topicos, criadoEm: Date.now(), consumidos: 0 };
}

/** Limpa o cache de lotes (usado pelos testes). */
function limparCacheLotes() {
  cacheLotes.clear();
}

// ===========================================================================
// 🔍 AGENT 1 — PESQUISA
// ===========================================================================

async function agentPesquisa(ctx, log) {
  log('🔍 Agent Pesquisa: buscando conteudo viral...');
  talvezFalhar('pesquisa');

  const nicho = ctx.nicho;
  let lote = cacheLotes.get(nicho);
  let veioDoCache = false;

  if (config.MELHORIAS.LOTE_PESQUISA && loteValido(lote)) {
    // MELHORIA 5: reaproveita o lote -> nao gasta chamada de API
    veioDoCache = true;
    store.countApiCallSaved(1);
    log('♻️ lote reaproveitado do cache (economia de 1 chamada de API)');
    await trabalhar(80, 200);
  } else {
    lote = await buscarLote(nicho, log);
    cacheLotes.set(nicho, lote);
  }

  // MELHORIA 4: anti-repeticao — descarta topicos usados nos ultimos N videos
  const recentes = config.MELHORIAS.ANTI_REPETICAO
    ? store.recentTopicIds(config.MELHORIAS.ANTI_REPETICAO_JANELA, nicho)
    : [];

  const disponiveis = lote.topicos.filter((t) => !recentes.includes(t.id));
  let topico;
  let anguloNovo = null;

  if (disponiveis.length > 0) {
    topico = disponiveis[0];
    if (recentes.length) {
      log(`🚫 anti-repeticao: ${recentes.length} topico(s) recente(s) ignorado(s)`);
    }
  } else {
    // Todos os topicos do lote ja foram usados: em vez de repetir igual,
    // forcamos um angulo novo sobre o topico mais antigo.
    topico = lote.topicos[lote.consumidos % lote.topicos.length];
    // Angulo escolhido por indice (nao aleatorio) para nao gerar dois
    // videos com exatamente o mesmo titulo.
    anguloNovo = ANGULOS[Math.floor(lote.consumidos / lote.topicos.length) % ANGULOS.length];
    log(`♻️ topicos esgotados, gerando angulo novo: "${anguloNovo}"`);
  }

  lote.consumidos += 1;

  const pesquisa = {
    topicoId: anguloNovo ? `${topico.id}-${slug(anguloNovo)}` : topico.id,
    titulo: anguloNovo ? `${topico.titulo} — ${anguloNovo}` : topico.titulo,
    fato: topico.fato,
    fonte: topico.fonte,
    viralScore: topico.viralScore,
    anguloNovo,
    veioDoCache,
    pesquisadoEm: new Date().toISOString(),
  };

  log(`✅ topico escolhido: "${pesquisa.titulo}" (score ${pesquisa.viralScore})`);
  return { pesquisa };
}

// ===========================================================================
// ✍️ AGENT 2 — ROTEIRO
// ===========================================================================

const HOOKS = [
  'Voce nao vai acreditar nisso:',
  'Ninguem comenta sobre isso, mas',
  'Isso aqui mudou tudo:',
  'Aposto que voce nao sabia:',
  'Para tudo, porque',
  'Esse detalhe passou batido:',
];

const PONTES = [
  'E tem mais:',
  'O detalhe e esse:',
  'E olha o motivo:',
  'Agora presta atencao:',
];

const CTAS = [
  'Segue aqui que tem mais todo dia.',
  'Comenta se voce ja sabia dessa.',
  'Salva esse video pra nao esquecer.',
  'Manda pra aquele amigo que joga.',
];

async function agentRoteiro(ctx, log) {
  log('✍️ Agent Roteiro: escrevendo script de 20-30s...');
  talvezFalhar('roteiro');
  await trabalhar(400, 900);

  // PLUG AQUI: Claude / GPT para gerar o roteiro a partir de ctx.pesquisa.
  const { pesquisa } = ctx;
  const nicho = config.NICHOS[ctx.nicho];

  const hook = pick(HOOKS);
  const ponte = pick(PONTES);
  const cta = pick(CTAS);

  const blocos = [
    `${hook} ${pesquisa.titulo}.`,
    `${pesquisa.fato.charAt(0).toUpperCase()}${pesquisa.fato.slice(1)}.`,
    `${ponte} isso é exatamente o tipo de detalhe que separa quem joga de quem entende de ${nicho.label.toLowerCase()}.`,
    cta,
  ];

  let texto = blocos.join(' ');
  let duracao = estimarDuracao(texto);

  // Garante a janela de 20-30s: corta se passou, estica se ficou curto.
  const { MIN_DURATION, MAX_DURATION, WORDS_PER_SECOND } = config.VIDEO;
  if (duracao > MAX_DURATION) {
    const maxPalavras = Math.floor(MAX_DURATION * WORDS_PER_SECOND);
    texto = texto.split(/\s+/).slice(0, maxPalavras).join(' ').replace(/[,;:]$/, '') + '.';
    duracao = estimarDuracao(texto);
    log(`✂️ script cortado para caber em ${MAX_DURATION}s`);
  } else if (duracao < MIN_DURATION) {
    texto += ` ${pick(['O jogo nunca mais foi o mesmo depois disso.', 'Poucos reparam nisso até alguem mostrar.', 'E isso é só a ponta do iceberg.'])} ${pick(CTAS)}`;
    duracao = estimarDuracao(texto);
    log(`➕ script esticado para passar de ${MIN_DURATION}s`);
  }

  // Divide em cenas — uma cena por imagem.
  const frases = texto.match(/[^.!?]+[.!?]+/g) || [texto];
  const cenas = [];
  const porCena = Math.ceil(frases.length / config.VIDEO.IMAGES_PER_VIDEO);
  for (let i = 0; i < config.VIDEO.IMAGES_PER_VIDEO; i++) {
    const trecho = frases.slice(i * porCena, (i + 1) * porCena).join(' ').trim();
    if (!trecho) break;
    cenas.push({
      index: cenas.length + 1,
      texto: trecho,
      duracao: Number((estimarDuracao(trecho)).toFixed(1)),
      prompt: `${pesquisa.titulo}, cena ${cenas.length + 1}, estilo cinematografico vertical`,
    });
  }

  const roteiro = {
    titulo: `${nicho.emoji} ${pesquisa.titulo}`,
    hook,
    cta,
    texto,
    cenas,
    palavras: contarPalavras(texto),
    duracaoEstimada: duracao,
    hashtags: nicho.hashtags,
  };

  log(`✅ script pronto: ${roteiro.palavras} palavras / ~${duracao}s / ${cenas.length} cenas`);
  return { roteiro };
}

// ===========================================================================
// 🎙️ AGENT 3 — AUDIO
// ===========================================================================

async function agentAudio(ctx, log) {
  log('🎙️ Agent Audio: gerando narracao...');
  talvezFalhar('audio');

  const nicho = config.NICHOS[ctx.nicho];

  // ------------------------------------------------------------- modo REAL
  // PLUG AQUI: ElevenLabs / Azure TTS / Google TTS.
  // Enquanto nao ha chave de TTS, geramos uma faixa AAC real com a duracao
  // certa (silenciosa) — o .mp4 sai assistivel e com audio valido.
  if (ctx.real) {
    const arquivo = path.join(ctx.tempDir, 'narracao.m4a');
    const faixa = await render.faixaAudio({
      arquivo,
      duracao: ctx.roteiro.duracaoEstimada,
      texto: ctx.roteiro.texto,
      tempDir: ctx.tempDir,
    });
    const stat = await fsp.stat(arquivo);
    const audio = {
      arquivo,
      voz: faixa.silencio ? `${nicho.voice} (nao sintetizada)` : faixa.voz,
      duracao: ctx.roteiro.duracaoEstimada,
      formato: 'm4a/aac',
      bitrate: '128kbps',
      sampleRate: 44100,
      tamanhoBytes: stat.size,
      silencio: faixa.silencio,
      simulado: false,
    };
    log(faixa.silencio
      ? `✅ faixa de audio real gerada, porem SILENCIOSA (sem TTS configurado — veja TTS_CMD)`
      : `✅ narracao sintetizada (${faixa.voz}, ${audio.duracao}s)`, 'ok');
    return { audio };
  }

  // -------------------------------------------------------- modo SIMULACAO
  await trabalhar(900, 1800);
  const arquivo = path.join(ctx.tempDir, 'narracao.mp3');
  const payload = [
    '# narracao simulada (placeholder)',
    `voz: ${nicho.voice}`,
    `duracao: ${ctx.roteiro.duracaoEstimada}s`,
    '',
    ctx.roteiro.texto,
  ].join('\n');
  await fsp.writeFile(arquivo, payload, 'utf8');

  const audio = {
    arquivo,
    voz: nicho.voice,
    duracao: ctx.roteiro.duracaoEstimada,
    formato: 'mp3',
    bitrate: '128kbps',
    sampleRate: 44100,
    tamanhoBytes: Buffer.byteLength(payload),
    simulado: true,
  };

  log(`✅ narracao gerada (${audio.voz}, ${audio.duracao}s)`);
  return { audio };
}

// ===========================================================================
// 🎨 AGENT 4 — IMAGENS
// ===========================================================================

const PALETAS = [
  ['#ff006e', '#8338ec'],
  ['#06ffa5', '#0b7285'],
  ['#ffbe0b', '#fb5607'],
  ['#3a86ff', '#023047'],
  ['#f72585', '#4361ee'],
];

function svgVertical({ titulo, legenda, indice, total, cores }) {
  const { WIDTH, HEIGHT } = config.VIDEO;
  const esc = (s) =>
    String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // Quebra o texto em linhas de ~22 caracteres para caber no formato vertical.
  const linhas = [];
  let linha = '';
  for (const palavra of String(legenda).split(/\s+/)) {
    if ((linha + ' ' + palavra).trim().length > 22) {
      linhas.push(linha.trim());
      linha = palavra;
    } else {
      linha += ' ' + palavra;
    }
  }
  if (linha.trim()) linhas.push(linha.trim());

  const tspans = linhas
    .slice(0, 8)
    .map((l, i) => `<tspan x="${WIDTH / 2}" dy="${i === 0 ? 0 : 92}">${esc(l)}</tspan>`)
    .join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${cores[0]}"/>
      <stop offset="100%" stop-color="${cores[1]}"/>
    </linearGradient>
  </defs>
  <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#g)"/>
  <rect y="${HEIGHT * 0.55}" width="${WIDTH}" height="${HEIGHT * 0.45}" fill="rgba(0,0,0,0.45)"/>
  <text x="${WIDTH / 2}" y="180" text-anchor="middle" font-family="Arial Black, Arial, sans-serif" font-size="44" fill="rgba(255,255,255,0.85)">${esc(titulo).slice(0, 40)}</text>
  <text x="${WIDTH / 2}" y="${HEIGHT * 0.62}" text-anchor="middle" font-family="Arial Black, Arial, sans-serif" font-size="78" fill="#ffffff">${tspans}</text>
  <text x="${WIDTH / 2}" y="${HEIGHT - 120}" text-anchor="middle" font-family="Arial, sans-serif" font-size="40" fill="rgba(255,255,255,0.7)">cena ${indice}/${total}</text>
</svg>`;
}

async function agentImagens(ctx, log) {
  log('🎨 Agent Imagens: criando visuais 1080x1920...');
  talvezFalhar('imagens');

  // PLUG AQUI: DALL-E / Midjourney / Stable Diffusion / Pexels API.
  const cenas = ctx.roteiro.cenas;
  const cores = pick(PALETAS);
  const imagens = [];

  // ------------------------------------------------------------- modo REAL
  // PNG 1080x1920 de verdade, desenhado pelo ffmpeg (gradiente + legenda).
  if (ctx.real) {
    for (const cena of cenas) {
      const arquivo = path.join(ctx.tempDir, `cena-${cena.index}.png`);
      await render.imagemCena({
        arquivo,
        tempDir: ctx.tempDir,
        titulo: ctx.roteiro.titulo,
        legenda: cena.texto,
        indice: cena.index,
        total: cenas.length,
        cores,
      });
      const stat = await fsp.stat(arquivo);
      imagens.push({
        arquivo, cena: cena.index,
        largura: config.VIDEO.WIDTH, altura: config.VIDEO.HEIGHT,
        origem: 'gerada (ffmpeg)', prompt: cena.prompt,
        tamanhoBytes: stat.size, simulado: false,
      });
      log(`🖼️ imagem ${cena.index}/${cenas.length} renderizada (png real)`);
    }
    log(`✅ ${imagens.length} imagens prontas`);
    return { imagens };
  }

  // -------------------------------------------------------- modo SIMULACAO
  for (const cena of cenas) {
    await trabalhar(350, 700);
    const arquivo = path.join(ctx.tempDir, `cena-${cena.index}.svg`);
    const svg = svgVertical({
      titulo: ctx.roteiro.titulo,
      legenda: cena.texto,
      indice: cena.index,
      total: cenas.length,
      cores,
    });
    await fsp.writeFile(arquivo, svg, 'utf8');
    imagens.push({
      arquivo,
      cena: cena.index,
      largura: config.VIDEO.WIDTH,
      altura: config.VIDEO.HEIGHT,
      origem: Math.random() > 0.5 ? 'gerada (IA)' : 'banco de imagens',
      prompt: cena.prompt,
      tamanhoBytes: Buffer.byteLength(svg),
    });
    log(`🖼️ imagem ${cena.index}/${cenas.length} pronta`);
  }

  log(`✅ ${imagens.length} imagens prontas`);
  return { imagens };
}

// ===========================================================================
// 🎬 AGENT 5 — EDICAO
// ===========================================================================

async function agentEdicao(ctx, log) {
  log('🎬 Agent Edicao: montando video final...');
  talvezFalhar('edicao');

  const nicho = config.NICHOS[ctx.nicho];
  const nomeBase = `${slug(ctx.roteiro.titulo) || 'video'}-${ctx.videoId.slice(-6)}`;
  const arquivoVideo = path.join(config.PATHS.OUTPUT, `${nomeBase}.${config.VIDEO.FORMAT}`);
  const arquivoManifesto = path.join(config.PATHS.OUTPUT, `${nomeBase}.json`);
  const arquivoThumb = path.join(config.PATHS.OUTPUT, `${nomeBase}-thumb.${ctx.real ? 'png' : 'svg'}`);

  // Monta a timeline (o que o ffmpeg receberia de verdade).
  let cursor = 0;
  const timeline = ctx.roteiro.cenas.map((cena, i) => {
    const entrada = {
      cena: cena.index,
      inicio: Number(cursor.toFixed(1)),
      fim: Number((cursor + cena.duracao).toFixed(1)),
      imagem: ctx.imagens[i] ? path.basename(ctx.imagens[i].arquivo) : null,
      legenda: cena.texto,
      transicao: pick(['fade', 'slide-up', 'zoom-in', 'whip-pan']),
    };
    cursor += cena.duracao;
    return entrada;
  });

  // ------------------------------------------------------------- modo REAL
  // O ffmpeg monta de verdade: um segmento por cena com Ken Burns e fade,
  // concatenados e muxados com o audio. `inspecionar` le o arquivo gerado
  // para o manifesto nao mentir sobre o que saiu.
  let probe = null;
  if (ctx.real) {
    await render.montarVideo({
      saida: arquivoVideo,
      tempDir: ctx.tempDir,
      cenas: ctx.imagens.map((img, i) => ({
        indice: img.cena,
        imagem: img.arquivo,
        duracao: ctx.roteiro.cenas[i] ? ctx.roteiro.cenas[i].duracao : 2,
      })),
      audio: ctx.audio.arquivo,
      duracaoTotal: cursor,
    });
    probe = await render.inspecionar(arquivoVideo);
    log(`🎞️ render real: ${probe.largura}x${probe.altura} ${probe.codecVideo}/${probe.codecAudio} · ${probe.duracao}s · ${(probe.bytes / 1024 / 1024).toFixed(2)}MB`);
  } else {
    await trabalhar(1200, 2400);
  }

  const manifesto = {
    videoId: ctx.videoId,
    titulo: ctx.roteiro.titulo,
    nicho: ctx.nicho,
    render: probe ? { real: true, ...probe } : { real: false, motivo: 'ffmpeg indisponivel ou RENDER_REAL=false' },
    descricao: `${ctx.roteiro.texto}\n\n${nicho.hashtags.join(' ')}`,
    hashtags: nicho.hashtags,
    resolucao: `${config.VIDEO.WIDTH}x${config.VIDEO.HEIGHT}`,
    fps: config.VIDEO.FPS,
    duracao: Number(cursor.toFixed(1)) || ctx.roteiro.duracaoEstimada,
    audio: { voz: ctx.audio.voz, duracao: ctx.audio.duracao, arquivo: path.basename(ctx.audio.arquivo) },
    imagens: ctx.imagens.map((i) => path.basename(i.arquivo)),
    timeline,
    script: ctx.roteiro.texto,
    pesquisa: ctx.pesquisa,
    geradoEm: new Date().toISOString(),
    simulado: config.SIMULACAO.ATIVA,
  };

  await fsp.writeFile(arquivoManifesto, JSON.stringify(manifesto, null, 2), 'utf8');

  if (!ctx.real) {
    // Placeholder do arquivo de video (sem ffmpeg na maquina).
    const conteudoVideo = [
      '### VIDEO SIMULADO — placeholder gerado pelo Agent Edicao ###',
      `titulo: ${manifesto.titulo}`,
      `resolucao: ${manifesto.resolucao} @ ${manifesto.fps}fps`,
      `duracao: ${manifesto.duracao}s`,
      `cenas: ${timeline.length}`,
      '',
      'Instale o ffmpeg para gerar o mp4 de verdade (o pipeline detecta sozinho).',
    ].join('\n');
    await fsp.writeFile(arquivoVideo, conteudoVideo, 'utf8');
  }

  // Thumbnail = primeira cena (png no modo real, svg na simulacao).
  if (ctx.imagens[0]) {
    await fsp.copyFile(ctx.imagens[0].arquivo, arquivoThumb);
  }

  const video = {
    arquivo: arquivoVideo,
    manifesto: arquivoManifesto,
    thumbnail: ctx.imagens[0] ? arquivoThumb : null,
    duracao: probe ? probe.duracao : manifesto.duracao,
    resolucao: manifesto.resolucao,
    tamanhoBytes: probe ? probe.bytes : (await fsp.stat(arquivoVideo)).size,
    real: Boolean(probe),
    probe,
    timeline,
    titulo: manifesto.titulo,
    descricao: manifesto.descricao,
    hashtags: manifesto.hashtags,
  };

  log(`✅ video montado: ${path.basename(arquivoVideo)} (${video.duracao}s, ${video.resolucao}${probe ? ', MP4 REAL' : ', placeholder'})`);
  return { video };
}

// ===========================================================================
// Publicacao (usada pelo POST /api/post-video)
// ===========================================================================

async function publicarYoutube(videoRecord, log = () => {}) {
  log('📤 enviando para o YouTube...');
  // PLUG AQUI: YouTube Data API v3 (videos.insert com resumable upload).
  await trabalhar(800, 1600);

  if (!config.YOUTUBE.SIMULADO) {
    throw new Error('Upload real nao configurado: defina as credenciais da YouTube Data API');
  }

  const id = crypto.randomBytes(6).toString('base64url');
  const resultado = {
    youtubeId: id,
    url: `https://youtube.com/shorts/${id}`,
    canal: config.YOUTUBE.CANAL,
    titulo: videoRecord.titulo,
    visibilidade: 'public',
    postadoEm: new Date().toISOString(),
    simulado: true,
  };
  log(`✅ publicado: ${resultado.url}`);
  return resultado;
}

// ===========================================================================
// Pipeline exportado (a ordem importa — o orchestrator usa isso)
// ===========================================================================

module.exports = {
  agentPesquisa,
  agentRoteiro,
  agentAudio,
  agentImagens,
  agentEdicao,
  publicarYoutube,
  limparCacheLotes,
  render,
  // utilitarios reutilizados pelo orchestrator/testes
  utils: { sleep, slug, contarPalavras, estimarDuracao, trabalhar },
  AGENTES: [
    { id: 'pesquisa', nome: '🔍 Agent Pesquisa', peso: 10 },
    { id: 'roteiro', nome: '✍️ Agent Roteiro', peso: 15 },
    { id: 'audio', nome: '🎙️ Agent Audio', peso: 25 },
    { id: 'imagens', nome: '🎨 Agent Imagens', peso: 25 },
    { id: 'edicao', nome: '🎬 Agent Edicao', peso: 25 },
  ],
};
