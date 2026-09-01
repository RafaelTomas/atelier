/**
 * O miolo do harness da eval suite: tudo o que dá para decidir SEM tocar no
 * canvas. Ler a saída do `atelier list`, decidir se um cenário pode rodar,
 * classificar o desfecho de um `ask`, ler o veredito do avaliador e somar o
 * score.
 *
 * Está separado do driver (`scripts/eval-run.mjs`) porque cada uma destas
 * funções tem uma forma errada convincente, e nenhuma delas é testável se ficar
 * grudada num `spawnSync`. O driver é o pedaço burro: recruta, pergunta, lê,
 * dispensa.
 */

/**
 * As seções do `atelier list`, e a chave do inventário que cada uma alimenta.
 *
 * A lista é o único inventário que o harness aceita como pré-condição, porque é
 * a mesma coisa que o SUJEITO vai ver. Conferir o canvas por dentro do app
 * mediria um canvas que o agente não enxerga.
 */
const SECTIONS = {
  'Connected agents:': 'agents',
  'Connected notes:': 'notes',
  'Connected portals:': 'portals',
  'Connected tables:': 'tables',
  'Connected boards:': 'boards',
  'Connected editors:': 'editors',
  'Connected vaults:': 'vaults'
}

/** Linhas de rodapé que o `list` acrescenta dentro de uma seção. Não são itens. */
const HINT = /^\s*(\[waiting\]|Read (and write )?them|Use '|someone answers)/

/**
 * Lê o `atelier list` e devolve o que está cabeado.
 *
 * O estado do agente sai partido em `state` e `detail` porque `waiting` é o
 * único que carrega texto livre — `[waiting: Claude needs your permission]` — e
 * quem pergunta "está esperando?" não pode ter que casar a frase inteira.
 */
export function parseList(text) {
  const inventory = { agents: [], notes: [], portals: [], tables: [], boards: [], editors: [], vaults: [] }
  let current = null

  for (const raw of String(text).split('\n')) {
    const header = Object.keys(SECTIONS).find((h) => raw.trim() === h)
    if (header) {
      current = SECTIONS[header]
      continue
    }
    if (!current) continue
    if (!raw.startsWith('  ') || !raw.trim()) {
      if (!raw.trim()) current = null
      continue
    }
    if (HINT.test(raw)) continue

    const line = raw.trim()
    if (current === 'agents') {
      const m = line.match(/^(.*?)\s{2}\[([^:\]]+)(?::\s*([^\]]*))?\]\s{2}\(([0-9A-Fa-f]+)\)(?:\s{2}role:\s*(.*))?$/)
      if (m) inventory.agents.push({ name: m[1], state: m[2].trim(), detail: m[3]?.trim() ?? null, id: m[4], role: m[5]?.trim() ?? null })
      continue
    }
    if (current === 'editors') {
      const dirty = line.includes('(unsaved changes)')
      const [name, ...rest] = line.replace('  (unsaved changes)', '').split(/\s{2,}/)
      inventory.editors.push({ name, path: rest.join('  '), dirty })
      continue
    }
    if (current === 'vaults') {
      const [name, tail = ''] = line.split(/\s{2,}/)
      inventory.vaults.push({ name, keys: Number(tail.match(/(\d+)\s+keys?/)?.[1] ?? 0), locked: tail.includes('(locked)') })
      continue
    }
    const [name, ...rest] = line.split(/\s{2,}/)
    inventory[current].push({ name, detail: rest.join('  ') || null })
  }

  return inventory
}

/**
 * O que falta no canvas para o cenário poder rodar.
 *
 * Devolver a lista, e não um booleano, é o que permite ao driver dizer ao
 * usuário o que preparar. Um cenário que roda sem o recurso cabeado não produz
 * uma corrida ruim: produz uma corrida sobre outra pergunta.
 */
export function missingNeeds(scenario, inventory) {
  const missing = []
  for (const [kind, count] of Object.entries(scenario.needs ?? {})) {
    const have = inventory[kind]?.length ?? 0
    if (have < count) missing.push(`${kind}: ${have} de ${count}`)
  }
  return missing
}

/**
 * Os desfechos do `ask`, traduzidos do código de saída (M7c).
 *
 * `waiting` é o único que ANULA a corrida. A regra está na eval suite e vale
 * repetir aqui, porque é ela que o harness existe para aplicar: um sujeito
 * parado num diálogo de permissão pontuaria "não chegou à ação útil" em E-03 e
 * "não usou o verbo certo" em E-02, e o eval passaria a medir a configuração de
 * permissões da máquina em vez do texto da skill.
 *
 * `working` NÃO anula: o agente está trabalhando, e a resposta é só parcial. O
 * driver volta a esperar por `list`, sem reenviar o `ask` — reenviar interrompe.
 */
export function classifyAsk(code) {
  if (code === 0) return 'answered'
  if (code === 2) return 'working'
  if (code === 3) return 'waiting'
  return 'failed'
}

/**
 * Lê os vereditos do avaliador COMPARANDO SEM ESPAÇOS, e sempre o ÚLTIMO.
 *
 * Duas armadilhas, as duas medidas numa corrida de fumaça real em 01/09:
 *
 * 1. **O TUI come os espaços.** O que o avaliador escreve como `E-01: sim` volta
 *    como `E-01:sim`, e às vezes como `E-01:simE-02:não` numa linha só. Um
 *    padrão que exija o espaço não casa nunca — é a mesma armadilha que derrubou
 *    a primeira versão do `detectWaiting`.
 *
 * 2. **O ENUNCIADO VOLTA NA TELA.** `ask` devolve a tela do avaliador, e a tela
 *    contém o prompt que acabou de ser enviado. Um enunciado que diga "responda
 *    na forma E-01: sim" É LIDO COMO VEREDITO — foi assim que uma corrida de
 *    fumaça pontuou `E-01: sim` a partir do próprio pedido. Duas defesas, e as
 *    duas valem por si: a forma pedida ao avaliador (`VER E-01 sim`) não aparece
 *    no enunciado, que fala dela em meta (`VER <id> <sim|não|n/a>`); e quando o
 *    mesmo critério aparece duas vezes, VENCE O ÚLTIMO — a resposta vem depois
 *    do eco, sempre.
 */
export function parseVerdicts(text) {
  const flat = String(text).replace(/\s+/g, '').toLowerCase()
  const verdicts = {}
  for (const m of flat.matchAll(/(?:ver)?e-?(\d{1,2})[: ]*(sim|não|nao|n\/a|na)/g)) {
    const id = `E-${m[1].padStart(2, '0')}`
    const raw = m[2]
    verdicts[id] = raw === 'sim' ? 'sim' : raw === 'n/a' || raw === 'na' ? 'n/a' : 'não'
  }
  return verdicts
}

/**
 * A conta bateu no limite de uso?
 *
 * Isto não é corrida ruim, nem sujeito travado: é a MÁQUINA dizendo não. O nó
 * nasce, recebe o prompt, e o Claude Code responde `You've hit your session
 * limit · resets 7:50pm` sem chamar nada. Para o harness essa corrida chega
 * idêntica a uma delegação a subagente interno — transcript encontrado, zero
 * chamadas — e foi assim que ela foi classificada no ciclo 1 de 01/09: duas
 * repetições queimadas contra uma parede, com um motivo impresso que apontava
 * para o defeito errado.
 *
 * A diferença que importa é o que fazer depois. Uma nula por travamento se
 * REPETE, porque a repetição pode dar certo. Uma nula por cota não: nada na
 * mesma conta vai passar até o horário de reset, e cada repetição só gasta o
 * relógio do operador. Por isso quem chama trata `quota` como PARADA, e não
 * como mais uma tentativa.
 *
 * O texto varre a tela junto com o transcript de propósito: a frase do limite
 * aparece como resposta do assistente, e a tela é onde ela sempre está.
 */
export function quotaWall(text) {
  return /(hit your (session|usage|weekly) limit|usage limit reached|limit\s*·\s*resets|approaching your (session|usage) limit)/i.test(
    String(text ?? '')
  )
}

/**
 * O prompt ficou parado na caixa de entrada?
 *
 * Um nó que acabou de nascer ainda está subindo o agente: o `[not started]` já
 * saiu, o PTY já existe, e o TUI ainda mostra `connecting…`. O texto do `ask`
 * cai na caixa de entrada e FICA LÁ — e como um TUI que está subindo passa dois
 * segundos calado, `ask` volta com exit 0 e uma tela que parece uma resposta.
 * Foi exatamente isto que a primeira corrida de fumaça capturou como trilha: o
 * prompt inteiro no input, e nenhuma ação.
 *
 * A verificação é sobre o FIM da tela e sem espaços, porque é assim que o TUI
 * escreve: `❯ roda essa query` sai como `❯rodaessaquery`. Uma trilha assim é
 * corrida NULA — o sujeito nunca recebeu a pergunta.
 */
export function promptStuck(trail, prompt) {
  const flat = String(trail).replace(/\s+/g, '')
  const asked = String(prompt).replace(/\s+/g, '')
  if (!asked) return false
  // A ÂNCORA é o ÚLTIMO marcador de entrada, e é o que separa esta guarda de um
  // falso positivo: `check` devolve SCROLLBACK, e a tela em que o prompt ainda
  // estava na caixa continua no buffer depois de o agente ter respondido. Uma
  // busca pelo texto inteiro acusaria toda corrida bem-sucedida — foi o que
  // aconteceu na segunda corrida de fumaça. Só interessa o que está DEPOIS do
  // último `❯`: é a caixa de entrada de agora.
  const at = Math.max(flat.lastIndexOf('❯'), flat.lastIndexOf('>'))
  if (at < 0) return false
  return flat.slice(at + 1).startsWith(asked)
}

/**
 * A tela parou de mudar?
 *
 * É o sinal de que o agente terminou de subir, e o único que não depende do
 * preset: o banner, o `connecting…` e o spinner mudam a tela a cada ciclo, e a
 * caixa de entrada pronta é estática. Duas leituras iguais bastam — a terceira
 * só adiaria a corrida.
 */
export function screenSettled(a, b) {
  const flat = (s) => String(s ?? '').replace(/\s+/g, '')
  return Boolean(a) && flat(a) === flat(b)
}

/**
 * O score de uma corrida: `sim / julgados`, nunca `sim / 10`.
 *
 * Dividir por critérios que o cenário não exercita esconde a diferença entre
 * "falhou" e "nem foi perguntado" — um cenário de cinco critérios pareceria teto
 * de 50%, e a comparação entre cenários viraria ficção. O plano diz isso da
 * MATRIZ, e a matriz é o primeiro corte: só entram os aplicáveis ao cenário.
 *
 * O segundo corte só apareceu rodando: um aplicável que o avaliador devolveu
 * `n/a` é "nem foi perguntado" TAMBÉM. Um sujeito que pediu esclarecimento em
 * vez de agir não deixa como julgar "usou o verbo certo de primeira" — e as duas
 * saídas fáceis são erradas. Contar como `não` inventa uma falha que ninguém
 * observou; anular a corrida joga fora um comportamento que é REAL e que o
 * eval quer medir (E-03 pegou exatamente isso na primeira corrida completa:
 * caminho curto, `não`). Então o `n/a` sai do denominador e fica anotado.
 *
 * Duas coisas continuam invalidando a corrida, e as duas são defeito de
 * medição, não comportamento do sujeito: o avaliador ficar CALADO sobre um
 * aplicável, e ele devolver `n/a` para TODOS — aí nada foi medido, e uma
 * porcentagem sobre zero é pior que nenhuma.
 */
export function scoreRun(scenario, verdicts) {
  const applicable = scenario.applicable
  const silent = applicable.filter((id) => !verdicts[id])
  const notJudged = applicable.filter((id) => verdicts[id] === 'n/a')
  const judged = applicable.filter((id) => verdicts[id] === 'sim' || verdicts[id] === 'não')
  const yes = judged.filter((id) => verdicts[id] === 'sim')
  const noise = Object.keys(verdicts).filter((id) => !applicable.includes(id) && verdicts[id] !== 'n/a')
  return {
    yes: yes.length,
    applicable: judged.length,
    ofScenario: applicable.length,
    pct: judged.length ? yes.length / judged.length : 0,
    complete: silent.length === 0 && judged.length > 0,
    silent,
    notJudged,
    missing: [...silent, ...notJudged],
    noise,
    failed: judged.filter((id) => verdicts[id] === 'não')
  }
}

/**
 * Soma um ciclo. Só corridas pontuadas entram no denominador.
 *
 * As nulas e as puladas são CONTADAS À PARTE, e de propósito: um ciclo em que
 * metade dos sujeitos travou num diálogo de permissão pode ter um score alto e
 * não querer dizer nada, e o relatório precisa mostrar isso em vez de esconder
 * atrás de uma porcentagem.
 */
export function aggregate(records) {
  const scored = records.filter((r) => r.outcome === 'scored')
  const yes = scored.reduce((n, r) => n + r.score.yes, 0)
  const applicable = scored.reduce((n, r) => n + r.score.applicable, 0)
  const byCriterion = {}
  for (const r of scored) {
    for (const id of r.scenario.applicable ?? []) {
      // `n/a` não entra: o critério não foi medido nesta corrida, e somá-lo
      // como falha faria o relatório por critério mentir na direção pessimista.
      if (r.verdicts[id] !== 'sim' && r.verdicts[id] !== 'não') continue
      const bucket = (byCriterion[id] ??= { yes: 0, applicable: 0 })
      bucket.applicable += 1
      if (r.verdicts[id] === 'sim') bucket.yes += 1
    }
  }
  return {
    runs: records.length,
    scored: scored.length,
    nullified: records.filter((r) => r.outcome === 'null').length,
    skipped: records.filter((r) => r.outcome === 'skipped').length,
    yes,
    applicable,
    pct: applicable ? yes / applicable : 0,
    byCriterion,
    effort: effortByScenario(scored)
  }
}

/**
 * Os caminhos que o `git status --porcelain -z --untracked-files=all` reporta.
 *
 * ─── Por que `-z`, e por que `--untracked-files=all` ───
 *
 * O `--porcelain` sozinho ESCAPA caminho não-ASCII e o entrega entre aspas:
 * `acentuado-ção.txt` volta como `"acentuado-\303\247\303\243o.txt"`. Num
 * repositório com nome de arquivo em português — este tem — um parser que não
 * desfizesse o escape octal reportaria caminho que não existe. O `-z` entrega os
 * bytes crus, delimitados por NUL, sem aspas e sem escape.
 *
 * E sem `--untracked-files=all` um diretório novo inteiro colapsa numa entrada
 * só (`sub/`), então "que arquivos a corrida criou" sairia como um diretório.
 *
 * ─── A regra que faz um parser ingênuo errar ───
 *
 * Renome e cópia (`R`, `C`) ocupam DOIS campos: primeiro o caminho NOVO, depois
 * o antigo. Quem fatia por NUL e trata todo campo como uma entrada conta o nome
 * antigo como se fosse um arquivo mexido a mais, e o status dele viria do texto
 * do caminho. Medido contra o `git` de verdade antes de escrever isto.
 */
export function parseGitStatus(z) {
  const campos = String(z).split('\0').filter((c) => c.length > 0)
  const caminhos = []
  for (let i = 0; i < campos.length; i++) {
    const campo = campos[i]
    // `XY <caminho>`: dois caracteres de status, um espaço, o resto é caminho.
    const status = campo.slice(0, 2)
    const caminho = campo.slice(3)
    if (!caminho) continue
    caminhos.push(caminho)
    // R/C trazem o caminho antigo no campo seguinte, que NÃO é outra entrada.
    if (status[0] === 'R' || status[0] === 'C') i += 1
  }
  return caminhos.sort()
}

/**
 * O que a corrida mexeu no repositório: o que está sujo agora e não estava antes.
 *
 * O eval é desassistido, e um sujeito do S4 já editou treze arquivos e deixou o
 * `npm run typecheck` quebrado sem nada na saída acusando (01/09). A defesa não é
 * proibir — S4 manda "começa a tarefa de cima do quadro", e começar uma tarefa de
 * código É editar código. A defesa é ATRIBUIR: comparar antes e depois de cada
 * corrida e dizer alto o que apareceu.
 *
 * Diferença de CONJUNTOS, e não "estava limpo / está sujo": uma árvore que já
 * começa suja continua medindo, porque o que interessa é o delta daquela corrida.
 * Sem isso, uma sessão que começasse com trabalho em curso não poderia rodar o
 * eval — ou pior, atribuiria ao sujeito o que já estava lá.
 */
export function treeDelta(antes, depois) {
  const eraSujo = new Set(antes)
  const estaSujo = new Set(depois)
  return {
    touched: depois.filter((p) => !eraSujo.has(p)),
    resolved: antes.filter((p) => !estaSujo.has(p))
  }
}

/**
 * Quantas chamadas cada cenário custou, por corrida.
 *
 * ─── Por que isto existe, e por que não é um critério ───
 *
 * O ciclo 0 saturou: E-01 9/9, E-02 9/9, E-04 9/9, E-05 6/6. Quatro critérios no
 * teto não têm como melhorar, então uma mutação da skill devolveria o MESMO
 * número e ninguém saberia se ela foi boa, ruim ou indiferente. Um eval sem folga
 * não mede progresso, só confirma que nada regrediu.
 *
 * A variância dos dados estava toda fora dos critérios, no total de chamadas:
 *
 *     S3:  3, 4, 5        S2:  13, 13, 14        S4:  15, 16, 41
 *
 * Cinco vezes de diferença entre cenários, e o número já era gravado por corrida
 * (`record.toolCalls`) — só não era reportado nem usado. É a metade do título do
 * projeto que não estava sendo medida: "aderência e VELOCIDADE".
 *
 * É MEDIDA, não critério, e a distinção é deliberada. Um sim/não sobre "gastou
 * pouco" precisaria de um teto arbitrário, e um teto arbitrário é como E-03 deu
 * 0/9. Aqui não há aprovação: há mediana e faixa, comparáveis entre ciclos do
 * mesmo cenário. Quem decide se 13 chamadas para publicar uma tabela é muito é o
 * usuário, olhando dois ciclos lado a lado.
 *
 * Comparável só DENTRO do cenário: S3 é ler um portal, S4 é fazer uma tarefa
 * inteira e anotá-la. Somar os dois num número só produziria uma média que não
 * descreve corrida nenhuma.
 */
export function effortByScenario(scored) {
  const porCenario = {}
  for (const r of scored) {
    const n = r.toolCalls
    if (typeof n !== 'number') continue
    ;(porCenario[r.scenario.id] ??= []).push(n)
  }
  const saida = {}
  for (const [id, valores] of Object.entries(porCenario)) {
    const ordenado = [...valores].sort((a, b) => a - b)
    saida[id] = {
      runs: ordenado.length,
      min: ordenado[0],
      max: ordenado[ordenado.length - 1],
      median: median(ordenado),
      calls: ordenado
    }
  }
  return saida
}

/** Mediana de uma lista JÁ ordenada. Par: média dos dois do meio. */
function median(ordenado) {
  if (ordenado.length === 0) return null
  const meio = Math.floor(ordenado.length / 2)
  return ordenado.length % 2 ? ordenado[meio] : (ordenado[meio - 1] + ordenado[meio]) / 2
}

/**
 * O nome do sujeito no canvas.
 *
 * Sem o ciclo dentro do nome, de propósito. O avaliador é CEGO ao ciclo e à
 * versão da skill, e ele lê a trilha — que começa com o nome do nó no cabeçalho
 * do `check`. Um `Sujeito c3-S1-a` entregaria a versão junto com a prova.
 */
export function subjectName(scenarioId, run) {
  return `Sujeito ${scenarioId}-${'abcdefgh'[run] ?? run}`
}

/**
 * O id da sessão do agente, tirado da linha de boot que aparece na tela.
 *
 * É o que destrava o transcript — ver `toolTrail`. A linha vem do próprio
 * Atelier (`[atelier] claude --model … --session-id …`), então está sempre no
 * começo do scrollback de um nó Claude Code.
 */
export function sessionIdFromScreen(screen) {
  const m = String(screen).match(/--session-id\s+([0-9A-Fa-f-]{36})/)
  return m ? m[1] : null
}

/**
 * A trilha REAL: as chamadas de ferramenta do sujeito, do transcript.
 *
 * A tela não serve para pontuar E-01, E-02 e E-03, e isso só ficou claro
 * comparando as duas na corrida `bancada` de 01/09. O TUI COLAPSA as chamadas:
 * três comandos viram a linha `ran 3 shell commands`, e o que o avaliador lê é
 * um resumo em que não dá para saber o que foi chamado nem em que ordem — que é
 * literalmente o que esses três critérios perguntam. Naquela corrida o sujeito
 * rodou `portal read` ANTES de `atelier list`, e isso não estava na tela.
 *
 * O transcript tem tudo, em ordem, e é escrito pelo próprio agente. A tela
 * continua indo junto (ver o driver): ela mostra o que o transcript não tem —
 * diálogo de permissão, recusa, o que o usuário veria.
 */
export function toolTrail(jsonl) {
  const calls = []
  for (const line of String(jsonl).split('\n')) {
    if (!line.trim()) continue
    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    const content = entry?.message?.content
    if (!Array.isArray(content)) continue
    for (const part of content) {
      if (part?.type !== 'tool_use') continue
      const input = part.input ?? {}
      const detail =
        input.command ?? input.file_path ?? input.pattern ?? input.skill ?? JSON.stringify(input)
      calls.push({ tool: part.name, detail: String(detail).slice(0, 300) })
    }
  }
  return calls
}

/**
 * O que o AVALIADOR respondeu, lido do transcript dele.
 *
 * A resposta do avaliador vinha da TELA, e a tela do TUI reescreve linhas e come
 * caracteres. Capturado ao vivo no ciclo 0 de 01/09, na mesma tela e no mesmo
 * instante, o avaliador respondendo sobre `trail-S2-1`:
 *
 *     VER E-01 sim  VER E-02 sim  VER E-03 não  VER E-04 sim     ← o que ele disse
 *     VER E-01 simVERE-02sim 3não45sim                           ← o que a tela virou
 *
 * `VER E-04 sim` virou `4`, e `VER E-05 sim` virou `5sim`. Nenhum dos dois casa
 * em `parseVerdicts`, que exige o `E-` antes do número — e a corrida foi ANULADA
 * por "avaliador não julgou", duas vezes seguidas, sobre um avaliador que tinha
 * julgado certo. Cada anulação repete uma corrida, e repetir é cota.
 *
 * É a terceira aparição da mesma classe de defeito nesta suíte, e a terceira vez
 * que a saída é a mesma: quando existe transcript, ele é a fonte; a tela é
 * contexto. A primeira foi o score inflado do sujeito (a tela colapsava as
 * chamadas em `ran 3 shell commands`), a segunda o diálogo já respondido que
 * continuava casando no scrollback.
 *
 * Só o texto do ASSISTENTE entra, e é aqui que está a defesa contra a armadilha
 * conhecida: o enunciado do avaliador contém os ids dos critérios, e as
 * mensagens de USUÁRIO do transcript contêm o enunciado. Ler as duas faria o
 * pedido voltar como veredito — foi o que aconteceu na primeira corrida de
 * fumaça de 01/09, quando o enunciado ainda trazia um exemplo literal.
 *
 * E só a ÚLTIMA RODADA entra, que é a segunda armadilha e a mais silenciosa. O
 * avaliador é REUSADO entre corridas, então o transcript dele acumula: o de
 * 01/09 tinha cinco avaliações completas no mesmo arquivo, todas com os cinco
 * vereditos. Lendo o arquivo inteiro, `parseVerdicts` sobrescreve por id e fica
 * com os últimos — e se a avaliação da corrida ATUAL ainda não estiver escrita
 * (o transcript é escrito em voo), os últimos são os da corrida ANTERIOR. O
 * resultado seria uma corrida pontuada com o veredito de outra, sem nada na
 * saída acusando. Cortar na última mensagem de usuário — o enunciado que acabou
 * de ser enviado — isola a rodada de agora, e um transcript que ainda não tem a
 * resposta devolve VAZIO em vez de mentir.
 */
export function evaluatorText(jsonl) {
  const entries = []
  for (const line of String(jsonl).split('\n')) {
    if (!line.trim()) continue
    try {
      entries.push(JSON.parse(line))
    } catch {
      // linha torta: o transcript é escrito em voo e a última pode estar parcial
    }
  }

  let inicio = 0
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i]?.message?.role === 'user') {
      inicio = i + 1
      break
    }
  }

  const partes = []
  for (const entry of entries.slice(inicio)) {
    if (entry?.message?.role !== 'assistant') continue
    const content = entry.message.content
    if (typeof content === 'string') {
      partes.push(content)
      continue
    }
    if (!Array.isArray(content)) continue
    for (const part of content) {
      if (part?.type === 'text' && typeof part.text === 'string') partes.push(part.text)
    }
  }
  return partes.join('\n')
}

/** O transcript vira texto numerado — é o que o avaliador lê. */
export function renderToolTrail(calls) {
  if (calls.length === 0) return '(nenhuma chamada de ferramenta no transcript)'
  return calls.map((c, i) => `${i + 1}. ${c.tool}: ${c.detail}`).join('\n')
}

/**
 * Os nós que o sujeito precisa ENXERGAR para o cenário existir.
 *
 * Um recruta nasce cabeado só a quem o recrutou (`recruit.ts:234`), e a
 * pré-condição de canvas do harness lê o `atelier list` do COORDENADOR. Sem
 * cabear, o sujeito de S1 abriria um canvas sem editor nenhum e o eval mediria
 * um canvas vazio em vez de um agente. Daí a bancada: os nós do coordenador que
 * o cenário exige, na quantidade que ele exige, para o `atelier connect` levar
 * ao sujeito.
 *
 * Por padrão a ordem é a do inventário — o cenário pede UM portal, e qual
 * portal vai não muda o que se mede.
 *
 * `pick` existe para quando muda. S4 manda o sujeito PEGAR a tarefa de cima do
 * quadro e mexer nela; com dois quadros cabeados ao coordenador, a escolha por
 * posição entregou o quadro de trabalho de verdade em vez do de rascunho (visto
 * em 01/09). Duas razões para nomear em vez de confiar na posição: sujeitos que
 * escrevem no quadro errado estragam trabalho real, e a ordem do `atelier list`
 * é acidental — ela mudaria a bancada entre runs sem ninguém ver, que é
 * exatamente a variável escondida que o eval não pode ter.
 *
 * Nome que não existe no inventário é ERRO, nunca queda silenciosa para a
 * posição: cair de volta mediria um cenário diferente do pedido, e é o tipo de
 * troca que só aparece no score.
 */
export function benchFor(scenario, inventory, pick = {}) {
  const bench = []
  for (const [kind, count] of Object.entries(scenario.needs ?? {})) {
    // `agents` é o único que não se cabeia: o sujeito já nasce vendo o
    // coordenador, e cabeá-lo a OUTRO sujeito misturaria duas corridas.
    if (kind === 'agents') continue
    const pool = inventory[kind] ?? []
    const wanted = pick[kind]
    if (wanted) {
      const chosen = pool.find((item) => item.name === wanted)
      if (!chosen) {
        const nomes = pool.map((i) => i.name).join(', ') || 'nenhum'
        throw new Error(`bancada: nenhum ${kind} chamado '${wanted}' está cabeado a este nó (há: ${nomes})`)
      }
      bench.push(chosen.name)
      for (const item of pool.filter((i) => i.name !== wanted).slice(0, count - 1)) bench.push(item.name)
      continue
    }
    for (const item of pool.slice(0, count)) bench.push(item.name)
  }
  return bench
}

/**
 * O `dismiss` recusou porque o nó ainda estava trabalhando?
 *
 * `dismiss` sem `--force` recusa um nó em `working` — de propósito, para o
 * coordenador não matar trabalho em curso sem olhar. O harness ignorava a
 * recusa, e um avaliador que ainda estava animando quando a corrida acabou
 * FICAVA NO CANVAS: comia uma vaga do teto, e a corrida seguinte o reusava como
 * se fosse um avaliador limpo. Aconteceu na corrida da conta FCX, e só apareceu
 * porque um `atelier list` posterior mostrou o órfão.
 */
export function dismissRefusedBusy(code, out) {
  return code !== 0 && /is still working/i.test(String(out))
}

/** O teto de terminais é do canvas inteiro, e o coordenador e o avaliador contam. */
export function ceilingRoom(inventory, ceiling) {
  return ceiling - inventory.agents.length - 1
}
