# Relatório de endurecimento

Campanha de caça a falhas no sistema, rodando em ciclos até o meio-dia de Brasília (2026-10-09).
Regra da campanha: **só corrigir bug real reproduzido**. Nada de refatorar código que funciona.

| | |
|---|---|
| Início | 09:18 BRT (12:18 UTC) |
| Suíte no início | 72/72 |
| Suíte agora | 79/79 |
| Bugs reais encontrados | 1 |
| Bugs corrigidos | 1 |

---

## Bugs encontrados e corrigidos

### 🐛 #1 — Perda total do histórico se o processo morrer durante a gravação

**Gravidade:** alta (perda de dados silenciosa)

`store.flush()` usava `fs.writeFileSync()` direto no arquivo final. Isso não é atômico: se o
processo morre no meio (Ctrl+C, queda de energia, OOM killer, PC suspendendo), o `videos.json`
fica truncado. E um JSON truncado caía no `catch` do `load()`, que **começava um banco novo** —
ou seja, todo o histórico de vídeos desaparecia sem aviso.

**Como foi reproduzido:** 20 ciclos de `kill -9` durante gravação contínua de um banco de
1700 vídeos (≈3 dias de piloto automático a 20 vídeos/hora, cenário realista):

```
tentativa 2:  CORROMPIDO (524288 bytes de 784358)
tentativa 3:  CORROMPIDO (983040 bytes de 784358)
tentativa 8:  CORROMPIDO (786432 bytes de 784358)
tentativa 16: CORROMPIDO (0 bytes de 784358)   <- arquivo zerado
RESULTADO: 20 mortes durante escrita · 4 arquivos corrompidos
```

Com 130 vídeos não reproduziu em 15 tentativas (janela de escrita curta demais) — o bug só
aparece quando o banco cresce, que é exatamente o que acontece com o piloto automático ligado.

**Correção** (`store.js`): troca por rename, que o sistema de arquivos faz de forma atômica.

1. grava num `.tmp` e dá `fsync` (conteúdo no disco antes de qualquer troca)
2. renomeia o atual para `.bak` (só metadado, não copia bytes)
3. renomeia o `.tmp` para o nome final

Quem lê sempre enxerga a versão velha inteira ou a nova inteira, nunca um meio-termo. E se o
processo morrer entre os dois renames, o `.bak` continua íntegro — por isso o `load()` agora
tenta: **principal → backup → banco novo**.

**Verificação:** mesmas 20 mortes durante escrita, agora pelo `store` real: **0 perdas**.

**Efeito colateral que eu mesmo introduzi e corrigi:** a primeira versão da correção fazia
uma instalação nova imprimir `nenhum banco utilizável, iniciando novo` como se fosse erro.
Agora só avisa quando havia arquivo e ele estava ilegível; banco inexistente carrega em silêncio.

**Testes novos (7):** escrita atômica, criação do backup, conteúdo do backup, ausência de `.tmp`
residual, `.tmp` órfão de uma morte anterior não contamina a próxima escrita, recuperação a
partir do backup em subprocesso real, e primeira execução silenciosa.

---

## Ângulos atacados

| # | Ângulo | Como | Resultado |
|---|---|---|---|
| 1 | Carga (30 vídeos) | fila cheia de uma vez, driver de memória | ✅ 30/30 prontos, 0 perdidos, concorrência respeitada (máx 2) |
| 2 | Carga (100 vídeos) | 100 numa chamada só | ✅ 130/130 prontos, 0 falhas, 29s |
| 3 | Vazamento de memória | RSS do processo node durante 130 vídeos | ✅ 64MB → pico 70MB → 69MB. Sem crescimento sustentado |
| 4 | Vazamento de descritores | `/proc/PID/fd` durante 130 vídeos | ✅ 22 → pico 23 → 23. Estável |
| 5 | Latência sob carga | 10 amostras do `/api/dashboard` com 130 vídeos | ✅ mediana 2ms, máx 3ms (resposta de 43KB) |
| 6 | Morte do processo (banco pequeno) | 15× `kill -9` durante gravação, 130 vídeos | ✅ 0 corrompidos |
| 7 | Morte do processo (banco grande) | 20× `kill -9` durante gravação, 1700 vídeos | 🐛 **bug #1** → corrigido → 0 perdas |
| 8 | Banco corrompido | truncar o principal, deixar o backup bom | ✅ recupera do backup |
| 9 | Banco destruído | corromper principal **e** backup | ✅ avisa e começa novo, sem derrubar o servidor |

## Limites conhecidos (não são bugs — são escolhas de projeto)

- **O store é um JSON único reescrito inteiro a cada flush.** Com 130 vídeos o arquivo tem 388KB
  e a gravação é imperceptível. Em torno de 10 mil vídeos (≈3 semanas de piloto automático
  ininterrupto) isso passa de 30MB por gravação e vira gargalo. A saída é trocar `store.js` por
  SQLite — a API do módulo foi feita pequena de propósito para essa troca ser local.
