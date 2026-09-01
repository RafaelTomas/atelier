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
    byCriterion
  }
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
