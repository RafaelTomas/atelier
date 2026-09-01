/**
 * O harness da eval suite — as decisões que ele toma sem tocar no canvas.
 *
 * Um harness errado não falha: ele PONTUA. Ele devolve uma porcentagem com cara
 * de medida, e a otimização inteira passa a perseguir um número que não mede
 * nada. Daí este arquivo cobrir exatamente os quatro lugares onde a forma errada
 * é convincente:
 *
 *   • o denominador (`sim / aplicáveis`, nunca `sim / 10`);
 *   • a corrida NULA, que não é corrida ruim;
 *   • a pré-condição de canvas, que separa "o agente falhou" de "não havia o
 *     recurso";
 *   • a leitura do veredito, que chega pela TELA do avaliador — e o TUI come os
 *     espaços, a mesma armadilha do `detectWaiting`.
 *
 * Uso: node scripts/test-eval-harness.mjs
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

import {
  benchFor,
  sessionIdFromScreen,
  toolTrail,
  renderToolTrail,
  dismissRefusedBusy,
  parseList,
  missingNeeds,
  classifyAsk,
  parseVerdicts,
  promptStuck,
  screenSettled,
  scoreRun,
  aggregate,
  subjectName,
  ceilingRoom
} from './eval/harness.mjs'
import { SCENARIOS, SENTINELS, CRITERIA, CONFIG, scenario, applicablePairs } from './eval/suite.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const STUCK = await readFile(join(ROOT, 'scripts/fixtures/trilha-prompt-preso.txt'), 'utf8')
const ANSWERED = await readFile(join(ROOT, 'scripts/fixtures/trilha-respondida.txt'), 'utf8')
const STUCK_BOOT = STUCK

let passed = 0
let failed = 0
const test = (name, fn) => {
  try {
    fn()
    passed++
    console.log(`  ok  ${name}`)
  } catch (err) {
    failed++
    console.log(`FAIL  ${name}\n      ${err.message}`)
  }
}

// ─── A saída real do `atelier list` ───────────────────────────────────────────

/**
 * Tela real, do canvas desta sessão, com um sujeito parado num diálogo.
 * Reproduz o que `list.ts` monta: rodapés dentro das seções, `role:` no fim da
 * linha do agente, e o `(unsaved changes)` que S7 depende de enxergar.
 */
const LIST = `You are an ARTISAN: delegate by opening NODES on this canvas, never as
subagents inside your own session.

Connected agents:
  Cobaia  [waiting: Claude needs your permission]  (247680C8)
  Sujeito S1-a  [working]  (11223344)
  Velho  [exited]  (99887766)  role: Revisor
  [waiting] = stopped, asking the USER to answer. It will not move until
  someone answers in the node — reading its screen again will not unblock it.

Connected notes:
  Decisões

Connected portals:
  App local  http://localhost:5173

Connected boards:
  Tarefas  todo 7  doing 1  done 5
  Read and write them with 'atelier todo …'.

Connected editors:
  index.ts  /home/user/src/main/index.ts  (unsaved changes)
  puro.ts  /home/user/src/puro.ts
  Read them with 'atelier editor read'; edit the file with your own tools.

Connected vaults:
  Cofre  3 keys
  Use 'atelier vault list' for the key names.`

const inv = parseList(LIST)

test('parseList separa os agentes com estado, detalhe e id', () => {
  assert.equal(inv.agents.length, 3)
  assert.deepEqual(
    inv.agents.map((a) => [a.name, a.state, a.detail]),
    [
      ['Cobaia', 'waiting', 'Claude needs your permission'],
      ['Sujeito S1-a', 'working', null],
      ['Velho', 'exited', null]
    ]
  )
  assert.equal(inv.agents[2].role, 'Revisor')
})

test('os rodapés das seções não viram itens', () => {
  // `[waiting] = stopped…` e `Read them with…` começam com dois espaços,
  // exatamente como os itens. Contá-los inflaria todo inventário.
  assert.equal(inv.notes.length, 1)
  assert.equal(inv.boards.length, 1)
  assert.equal(inv.vaults.length, 1)
  assert.equal(inv.editors.length, 2)
})

test('parseList enxerga o buffer sujo — é a pré-condição de S7', () => {
  assert.equal(inv.editors[0].dirty, true)
  assert.equal(inv.editors[0].path, '/home/user/src/main/index.ts')
  assert.equal(inv.editors[1].dirty, false)
})

test('um canvas vazio não vira inventário fantasma', () => {
  const empty = parseList('No connected agents, notes or portals.')
  for (const kind of Object.keys(empty)) assert.equal(empty[kind].length, 0, kind)
})

// ─── Pré-condição: pular não é zerar ──────────────────────────────────────────

test('cenário sem o recurso cabeado é PULADO, e diz o que falta', () => {
  const vazio = parseList('No connected agents, notes or portals.')
  assert.deepEqual(missingNeeds(scenario('S1'), vazio), ['editors: 0 de 1'])
  assert.deepEqual(missingNeeds(scenario('S4'), vazio), ['notes: 0 de 1', 'boards: 0 de 1'])
})

test('cenário com o canvas pronto não reclama de nada', () => {
  assert.deepEqual(missingNeeds(scenario('S1'), inv), [])
  assert.deepEqual(missingNeeds(scenario('S3'), inv), [])
  assert.deepEqual(missingNeeds(scenario('S8'), inv), [], 'S8 não precisa de nada cabeado')
})

test('S6 precisa de DOIS agentes ociosos, e um canvas com um só não serve', () => {
  const um = parseList('Connected agents:\n  Solo  [idle]  (11111111)')
  assert.deepEqual(missingNeeds(scenario('S6'), um), ['agents: 1 de 2'])
})

test('o teto de terminais conta o coordenador', () => {
  assert.equal(ceilingRoom(inv, CONFIG.terminalCeiling), 12 - 3 - 1)
  assert.ok(ceilingRoom(parseList(''), 1) < 1, 'canvas no teto tem de recusar')
})

// ─── A trilha de verdade vem do transcript, não da tela ───────────────────────

test('o id da sessão sai da linha de boot que o Atelier escreve na tela', () => {
  assert.equal(sessionIdFromScreen(STUCK_BOOT), '171D3492-364F-4728-A413-B9029085B80F')
  assert.equal(sessionIdFromScreen('nenhuma linha de boot aqui'), null)
})

test('toolTrail devolve as chamadas EM ORDEM, que é o que E-01 e E-03 perguntam', () => {
  // Transcript real da corrida `bancada` (01/09, conta FCX): o sujeito rodou
  // `portal read` ANTES de `atelier list` — agiu primeiro, inventariou depois.
  // Na TELA isso aparecia como `ran 3 shell commands`, e a ordem sumia.
  const jsonl = [
    JSON.stringify({ message: { content: [{ type: 'tool_use', name: 'Skill', input: { skill: 'atelier' } }] } }),
    JSON.stringify({ message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'atelier portal read "PaginaQuebrada"' } }] } }),
    JSON.stringify({ message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'atelier list' } }] } }),
    '{ isto não é json }',
    JSON.stringify({ message: { content: 'texto solto, não é lista' } })
  ].join('\n')
  const calls = toolTrail(jsonl)
  assert.deepEqual(calls.map((c) => c.tool), ['Skill', 'Bash', 'Bash'])
  assert.match(calls[1].detail, /portal read/)
  assert.match(calls[2].detail, /atelier list/)
  assert.ok(calls.findIndex((c) => /portal read/.test(c.detail)) < calls.findIndex((c) => /atelier list/.test(c.detail)),
    'a ordem é o dado: agir antes de inventariar é E-01 "não"')
})

test('transcript sem chamada nenhuma é trilha INÚTIL, e o driver anula a corrida', () => {
  // 01/09: o sujeito de S5 delegou para um subagente interno (`Agent(fork)`),
  // as chamadas foram para outra sessão, e o nó ficou sem nenhuma. O harness
  // pontuou 2/3 lendo só a TELA — a fonte que não serve para E-01, E-02 e E-03.
  // A regra vive no driver; aqui fica a condição que ele testa.
  assert.equal(toolTrail('').length, 0)
  assert.equal(renderToolTrail(toolTrail('')), '(nenhuma chamada de ferramenta no transcript)')
})

test('linha corrompida no transcript não derruba a trilha', () => {
  assert.deepEqual(toolTrail('{'), [])
  assert.equal(renderToolTrail([]), '(nenhuma chamada de ferramenta no transcript)')
})

// ─── A bancada: o sujeito não herda o cabeamento do coordenador ───────────────

test('S5 mede a metade de E-10 que este protocolo consegue medir', () => {
  // O cabo de cofre injeta as chaves no BOOT do PTY, e o sujeito é cabeado
  // depois de nascer — medido em 01/09 no /proc/<pid>/environ de um nó cabeado
  // ao cofre. `vault get` é o único caminho que existe para ele, e penalizá-lo
  // mediria a ordem em que o harness monta a bancada, não o agente.
  const s5 = scenario('S5')
  assert.ok(s5.applicable.includes('E-10'), 'o vazamento continua sendo medido')
  assert.ok(s5.applicable.includes('E-05'), 'publicar no canvas em vez de despejar texto')
  assert.match(s5.prompt, /banco de teste/)
  assert.match(s5.expected, /table create/)
})

test('a bancada leva ao sujeito os nós que o cenário exige', () => {
  assert.deepEqual(benchFor(scenario('S1'), inv), ['index.ts'])
  assert.deepEqual(benchFor(scenario('S4'), inv), ['Decisões', 'Tarefas'])
  assert.deepEqual(benchFor(scenario('S3'), inv), ['App local'])
})

test('cenário que não pede nada cabeado não monta bancada', () => {
  // S2 e S8 são os únicos que rodam sem cabo prévio, e foi com eles que o
  // piloto de 01/09 validou o protocolo.
  assert.deepEqual(benchFor(scenario('S2'), inv), [])
  assert.deepEqual(benchFor(scenario('S8'), inv), [])
})

test('agentes NÃO entram na bancada', () => {
  // O sujeito já nasce vendo o coordenador, e cabeá-lo a outro sujeito
  // misturaria duas corridas.
  assert.deepEqual(benchFor(scenario('S6'), inv), [])
})

test('a bancada respeita a quantidade pedida, e não despeja o canvas inteiro', () => {
  const muitos = parseList([
    'Connected notes:',
    '  Uma',
    '  Outra',
    '  Terceira'
  ].join('\n'))
  assert.deepEqual(benchFor({ needs: { notes: 1 } }, muitos), ['Uma'])
})

test('--bench escolhe o recurso pelo NOME, e não pela posição no list', () => {
  // Com dois quadros cabeados ao coordenador, a escolha por posição entregou ao
  // sujeito de S4 o quadro de trabalho de verdade em vez do de rascunho — e S4
  // manda o sujeito MEXER nos cartões. Visto em 01/09.
  const doisQuadros = parseList([
    'Connected notes:',
    '  Note 5',
    'Connected boards:',
    '  Tarefas  todo 6  doing 1  done 11',
    '  Rascunho eval  todo 3'
  ].join('\n'))
  assert.deepEqual(benchFor(scenario('S4'), doisQuadros), ['Note 5', 'Tarefas'])
  assert.deepEqual(
    benchFor(scenario('S4'), doisQuadros, { boards: 'Rascunho eval' }),
    ['Note 5', 'Rascunho eval']
  )
})

test('o nome escolhido vem PRIMEIRO, e a quantidade pedida continua valendo', () => {
  const tres = parseList([
    'Connected notes:',
    '  Uma',
    '  Outra',
    '  Terceira'
  ].join('\n'))
  assert.deepEqual(benchFor({ needs: { notes: 1 } }, tres, { notes: 'Terceira' }), ['Terceira'])
  assert.deepEqual(benchFor({ needs: { notes: 2 } }, tres, { notes: 'Terceira' }), ['Terceira', 'Uma'])
})

test('nome que não está cabeado é ERRO, nunca queda silenciosa para a posição', () => {
  // Cair de volta para a posição mediria um cenário diferente do pedido, e a
  // troca só apareceria no score — depois de gastar a cota.
  const inv1 = parseList(['Connected boards:', '  Tarefas  todo 6'].join('\n'))
  assert.throws(
    () => benchFor(scenario('S4'), inv1, { boards: 'Rascunho eval' }),
    /nenhum boards chamado 'Rascunho eval'/
  )
  assert.throws(() => benchFor(scenario('S4'), inv1, { boards: 'Rascunho eval' }), /há: Tarefas/)
})

test('pick de um tipo que o cenário não pede é ignorado', () => {
  // `--bench portals=X` numa corrida de S4 não deve arrastar portal nenhum para
  // a bancada: quem decide o que o cenário precisa é a matriz.
  assert.deepEqual(benchFor(scenario('S2'), inv, { portals: 'App local' }), [])
})

// ─── O desfecho do ask, e a corrida nula ──────────────────────────────────────

test('os códigos de saída do ask viram os desfechos do M7c', () => {
  assert.equal(classifyAsk(0), 'answered')
  assert.equal(classifyAsk(2), 'working')
  assert.equal(classifyAsk(3), 'waiting')
  assert.equal(classifyAsk(1), 'failed')
})

test('exit 0 é o ÚNICO desfecho que vale como resposta', () => {
  // Antes do M7 os três saíam com 0, e ler o do meio como conclusão foi o
  // defeito que anulou duas leituras da sessão de 01/09.
  const respostas = [0, 2, 3, 1].filter((c) => classifyAsk(c) === 'answered')
  assert.deepEqual(respostas, [0])
})

test('a recusa do dismiss por [working] é reconhecida, e o sucesso não vira recusa', () => {
  // Texto literal de dismiss.ts. O harness ignorava a recusa, e a corrida da
  // conta FCX deixou um Avaliador órfão no canvas por causa disso.
  assert.equal(dismissRefusedBusy(1, "error: 'Avaliador' is still working."), true)
  assert.equal(dismissRefusedBusy(0, "Dismissed 'Avaliador': process killed and node removed from the canvas."), false)
  assert.equal(dismissRefusedBusy(1, "error: agent 'Fulano' not found."), false, 'nó que já sumiu não é recusa por trabalho')
})

// ─── O veredito chega pela tela, e o TUI come os espaços ──────────────────────

test('parseVerdicts lê a resposta bem formada', () => {
  const v = parseVerdicts('E-01: sim\nE-02: não\nE-03: n/a\n')
  assert.deepEqual(v, { 'E-01': 'sim', 'E-02': 'não', 'E-03': 'n/a' })
})

test('parseVerdicts lê a MESMA resposta com os espaços comidos pelo TUI', () => {
  // É assim que ela chega de verdade: `atelier ask` devolve a tela do
  // avaliador, e a tela sai como `E-01:simE-02:não`.
  const v = parseVerdicts('E-01:simE-02:nãoE-03:n/aE-04:sim')
  assert.deepEqual(v, { 'E-01': 'sim', 'E-02': 'não', 'E-03': 'n/a', 'E-04': 'sim' })
})

test('parseVerdicts aceita `nao` sem acento e maiúsculas', () => {
  const v = parseVerdicts('E-01: NAO\nE-02: Sim')
  assert.deepEqual(v, { 'E-01': 'não', 'E-02': 'sim' })
})

test('conversa em volta do veredito não inventa critério', () => {
  const v = parseVerdicts('Li a trilha. O agente usou editor read.\nE-05: sim\nEspero ter ajudado.')
  assert.deepEqual(v, { 'E-05': 'sim' })
})

test('o eco do enunciado não vira veredito — vence o ÚLTIMO', () => {
  // `ask` devolve a TELA do avaliador, e a tela traz o pedido que acabou de
  // chegar. Uma corrida de fumaça de 01/09 pontuou `E-01: sim` lendo o próprio
  // enunciado, que dizia "responda na forma E-01: sim".
  const tela = 'Reply exactly in the form "E-01: sim" ... VER E-01 não VER E-02 sim'
  const v = parseVerdicts(tela)
  assert.equal(v['E-01'], 'não', 'o veredito de verdade vem depois do eco')
  assert.equal(v['E-02'], 'sim')
})

test('a forma VER <id> <veredito> é lida com e sem espaços', () => {
  assert.deepEqual(parseVerdicts('VER E-01 sim\nVER E-02 n/a'), { 'E-01': 'sim', 'E-02': 'n/a' })
  assert.deepEqual(parseVerdicts('VERE-01simVERE-02n/a'), { 'E-01': 'sim', 'E-02': 'n/a' })
})

// ─── O sujeito que nunca leu a pergunta ───────────────────────────────────────

test('trilha real com o prompt parado na caixa de entrada é NULA', () => {
  // Tela de verdade: `Sujeito S2-a`, haiku, capturado pela primeira corrida de
  // fumaça deste harness. O `[not started]` já tinha saído, o agente ainda
  // estava em `connecting…`, e o prompt ficou no input — `ask` voltou com exit
  // 0 e esta tela, que sem esta guarda iria para o avaliador como trilha.
  assert.equal(promptStuck(STUCK, 'roda essa query no banco e me mostra o resultado no canvas'), true)
})

test('uma trilha em que o agente AGIU não é confundida com prompt preso', () => {
  const agiu = '--- Sujeito S2-a [idle] last 200 lines ---\n● Bash(atelier table create …)\n  done'
  assert.equal(promptStuck(agiu, 'roda essa query no banco e me mostra o resultado no canvas'), false)
})

test('a trilha REAL de um agente que respondeu não acusa prompt preso', () => {
  // `check` devolve scrollback: o quadro em que o prompt ainda estava na caixa
  // continua no buffer DEPOIS da resposta. Buscar o texto no arquivo inteiro
  // acusava toda corrida bem-sucedida — a segunda corrida de fumaça anulou três
  // sujeitos que tinham respondido. A âncora é o ÚLTIMO `❯`.
  assert.equal(promptStuck(ANSWERED, 'roda essa query no banco e me mostra o resultado no canvas'), false)
  assert.ok(ANSWERED.replace(/\s+/g, '').includes('❯rodaessaquery'), 'o eco antigo TEM de estar no scrollback, senão o teste não prova nada')
})

test('screenSettled compara sem espaços, e uma tela que ainda muda não passa', () => {
  assert.equal(screenSettled('conectando…  ❯', 'conectando…❯'), true)
  assert.equal(screenSettled('Cogitating… (1s)', 'Cogitating… (2s)'), false)
  assert.equal(screenSettled(null, 'qualquer coisa'), false, 'a primeira leitura nunca é prontidão')
})

// ─── O score, e o denominador que o plano exige ───────────────────────────────

const s1 = scenario('S1')

test('score é sim/aplicáveis, e não sim/10', () => {
  const r = scoreRun(s1, { 'E-01': 'sim', 'E-02': 'sim', 'E-03': 'sim', 'E-04': 'sim', 'E-05': 'não' })
  assert.equal(r.applicable, 5)
  assert.equal(r.yes, 4)
  assert.equal(r.pct, 0.8)
  assert.deepEqual(r.failed, ['E-05'])
})

test('critério que o cenário não exercita não entra no denominador nem se vier respondido', () => {
  const r = scoreRun(s1, {
    'E-01': 'sim', 'E-02': 'sim', 'E-03': 'sim', 'E-04': 'sim', 'E-05': 'sim',
    'E-07': 'sim', 'E-09': 'não'
  })
  assert.equal(r.applicable, 5)
  assert.equal(r.pct, 1)
  assert.deepEqual(r.noise, ['E-07', 'E-09'], 'o excesso é ruído, e o harness precisa dizer')
})

test('n/a sai do denominador em vez de virar "não"', () => {
  // Um sujeito que pediu esclarecimento em vez de agir não deixa como julgar
  // E-02. Contar `não` inventaria uma falha que ninguém viu.
  const r = scoreRun(s1, { 'E-01': 'sim', 'E-02': 'n/a', 'E-03': 'não', 'E-04': 'sim', 'E-05': 'n/a' })
  assert.equal(r.applicable, 3, 'só os julgados formam o denominador')
  assert.equal(r.ofScenario, 5)
  assert.equal(r.yes, 2)
  assert.deepEqual(r.notJudged, ['E-02', 'E-05'])
  assert.equal(r.complete, true, 'isto é comportamento do sujeito, não defeito de medição')
})

test('avaliador CALADO sobre um aplicável invalida a corrida', () => {
  const r = scoreRun(s1, { 'E-01': 'sim', 'E-02': 'sim', 'E-04': 'sim' })
  assert.equal(r.complete, false)
  assert.deepEqual(r.silent, ['E-03', 'E-05'])
})

test('n/a em TODOS os aplicáveis não é corrida — é medição que não aconteceu', () => {
  const r = scoreRun(s1, { 'E-01': 'n/a', 'E-02': 'n/a', 'E-03': 'n/a', 'E-04': 'n/a', 'E-05': 'n/a' })
  assert.equal(r.complete, false)
  assert.equal(r.applicable, 0)
})

test('aggregate soma só o que foi pontuado, e conta nulas e puladas à parte', () => {
  const total = aggregate([
    { outcome: 'scored', scenario: { id: 'S1', applicable: s1.applicable }, verdicts: { 'E-01': 'sim', 'E-02': 'sim', 'E-03': 'sim', 'E-04': 'sim', 'E-05': 'não' }, score: { yes: 4, applicable: 5 } },
    { outcome: 'null', scenario: { id: 'S1', applicable: s1.applicable }, reason: 'sujeito travado' },
    { outcome: 'skipped', scenario: { id: 'S5', applicable: scenario('S5').applicable }, reason: 'sem cofre' }
  ])
  assert.equal(total.scored, 1)
  assert.equal(total.nullified, 1)
  assert.equal(total.skipped, 1)
  assert.equal(total.applicable, 5, 'a nula e a pulada não podem inflar o denominador')
  assert.equal(total.yes, 4)
  assert.deepEqual(total.byCriterion['E-05'], { yes: 0, applicable: 1 })
})

test('um ciclo em que tudo travou não devolve 0% — devolve nada pontuado', () => {
  const total = aggregate([
    { outcome: 'null', scenario: { id: 'S1', applicable: s1.applicable }, reason: 'travado' },
    { outcome: 'null', scenario: { id: 'S2', applicable: scenario('S2').applicable }, reason: 'travado' }
  ])
  assert.equal(total.applicable, 0)
  assert.equal(total.pct, 0)
  assert.equal(total.scored, 0, 'é isto que o relatório tem de mostrar, não a porcentagem')
})

// ─── O sujeito é cego ao ciclo ────────────────────────────────────────────────

test('o nome do sujeito não carrega o ciclo — o avaliador leria a versão na trilha', () => {
  assert.equal(subjectName('S1', 0), 'Sujeito S1-a')
  assert.equal(subjectName('S4', 2), 'Sujeito S4-c')
  assert.doesNotMatch(subjectName('S1', 0), /ciclo|cycle|v\d/i)
})

// ─── A suite como dado, contra a suite como documento ─────────────────────────

test('os dez critérios existem, e a matriz só usa critério que existe', () => {
  assert.equal(CRITERIA.length, 10)
  const ids = new Set(CRITERIA.map((c) => c.id))
  for (const s of SCENARIOS) for (const id of s.applicable) assert.ok(ids.has(id), `${s.id} cita ${id}`)
})

test('os oito cenários têm prompt literal e ação correta', () => {
  assert.equal(SCENARIOS.length, 8)
  for (const s of SCENARIOS) {
    assert.ok(s.prompt?.length > 10, `${s.id} sem prompt`)
    assert.ok(s.expected?.length > 5, `${s.id} sem ação correta`)
    assert.ok(s.applicable.length > 0, `${s.id} sem critério aplicável`)
  }
})

test('os sentinelas são S1–S4, e valem um terço do custo', () => {
  assert.deepEqual(SENTINELS, ['S1', 'S2', 'S3', 'S4'])
  assert.equal(applicablePairs(SENTINELS), 20)
  // 42, e não 41: S5 passou a terminar em publicação no canvas e por isso
  // exercita E-05 também. O total é calculado da matriz, nunca digitado.
  assert.equal(applicablePairs(), 42)
})

const DOC = join(ROOT, 'docs/eval-aderencia-agentes.md')
if (existsSync(DOC)) {
  const md = await readFile(DOC, 'utf8')
  test('a matriz do dado bate com a matriz do documento', () => {
    // `docs/` está no .gitignore: numa máquina recém-clonada este teste não
    // roda, e é por isso que a matriz vive no .mjs e não é lida de lá.
    for (const s of SCENARIOS) {
      const row = md.split('\n').find((l) => l.startsWith(`| ${s.id} |`) && l.includes('·') === l.includes('·'))
      if (!row || !/[✓·]/.test(row)) continue
      const marks = row.split('|').slice(2, 12).map((c) => c.trim())
      if (marks.length !== 10 || !marks.every((m) => m === '✓' || m === '·')) continue
      const fromDoc = CRITERIA.filter((c, i) => marks[i] === '✓').map((c) => c.id)
      assert.deepEqual(fromDoc, s.applicable, `${s.id} divergiu do markdown`)
    }
  })

  test('os prompts do dado são os prompts literais do documento', () => {
    for (const s of SCENARIOS) assert.ok(md.includes(s.prompt), `${s.id}: o prompt não está no documento`)
  })

  test('o documento não promete um total que a matriz dele não soma', () => {
    // O markdown trazia 44 e 21 escritos à mão; a matriz soma 41 e 20. Um
    // denominador digitado envelhece sozinho, e este teste é o que impede a
    // divergência de voltar.
    assert.ok(md.includes(`**${applicablePairs()}**`), `o total ${applicablePairs()} não está no documento`)
    assert.ok(md.includes(`**${applicablePairs(SENTINELS)}**`), `o total sentinela ${applicablePairs(SENTINELS)} não está no documento`)
  })
} else {
  console.log('  --  docs/eval-aderencia-agentes.md ausente (docs/ é gitignored): comparação com o documento pulada')
}

console.log(`\n${passed} passaram, ${failed} falharam\n`)
process.exit(failed === 0 ? 0 : 1)
