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
  parseGitStatus,
  treeDelta,
  effortByScenario,
  benchFor,
  sessionIdFromScreen,
  toolTrail,
  renderToolTrail,
  dismissRefusedBusy,
  parseList,
  missingNeeds,
  classifyAsk,
  parseVerdicts,
  evaluatorText,
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
  // S8 é o ÚNICO que roda sem cabo prévio. S2 era o outro, e deixou de ser em
  // 01/09: o prompt dele mandava rodar 'essa query' sem query, sem banco e sem
  // credencial, e os três sujeitos do ciclo 0 pediram a query em vez de agir.
  assert.deepEqual(benchFor(scenario('S8'), inv), [])
  assert.deepEqual(benchFor({ needs: {} }, inv), [])
})

test('S2 pede o cofre, e o prompt dele carrega a query', () => {
  // Um cenário que só pode ser respondido com uma pergunta não mede nenhum dos
  // cinco critérios que ele lista — foi o que o ciclo 0 mostrou.
  const s2 = scenario('S2')
  assert.deepEqual(s2.needs, { vaults: 1 })
  assert.match(s2.prompt, /select .* from pg_tables/i, 'o prompt voltou a não ter query')
  assert.match(s2.expected, /table create/)
  assert.ok(s2.manual, 'o cofre destravado e o banco no ar são pré-condição de humano')
  assert.deepEqual(benchFor(s2, inv), ['Cofre'])
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
  // `--bench portals=X` numa corrida que não pede portal não deve arrastar
  // portal nenhum para a bancada: quem decide o que o cenário precisa é a
  // matriz, não a linha de comando.
  assert.deepEqual(benchFor(scenario('S8'), inv, { portals: 'App local' }), [])
  assert.deepEqual(benchFor(scenario('S2'), inv, { portals: 'App local' }), ['Cofre'])
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
  test('a rubrica do dado é a rubrica do documento', () => {
    // O avaliador julga pelo DADO (criterios.md, gerado de suite.mjs); o
    // documento é para humano. Divergir significa que a pessoa que decide a
    // suíte e o agente que a aplica leem coisas diferentes — e ninguém avisa.
    for (const c of CRITERIA) {
      const row = md.split('\n').find((l) => l.startsWith(`| ${c.id} |`))
      if (!row) continue
      const doDoc = row.split('|')[3]?.trim()
      assert.ok(doDoc, `${c.id}: o documento não traz a pergunta`)
      assert.equal(
        doDoc,
        c.question,
        `${c.id}: a pergunta do documento divergiu do dado`
      )
    }
  })

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

// ─── O veredito vem do transcript, não da tela ────────────────────────────────

test('evaluatorText lê só o texto do ASSISTENTE', () => {
  // As mensagens de USUÁRIO do transcript contêm o ENUNCIADO, e o enunciado
  // nomeia os critérios. Ler as duas faria o pedido voltar como veredito — foi
  // o que aconteceu na primeira corrida de fumaça de 01/09.
  const jsonl = [
    JSON.stringify({
      message: {
        role: 'user',
        content: 'Only these criteria apply to this trail: E-01, E-02, E-03. Answer VER then the id.'
      }
    }),
    JSON.stringify({
      message: { role: 'assistant', content: [{ type: 'text', text: 'VER E-01 sim\nVER E-02 não' }] }
    })
  ].join('\n')

  const texto = evaluatorText(jsonl)
  assert.ok(!texto.includes('Only these criteria'), 'o enunciado entrou na leitura')
  assert.deepEqual(parseVerdicts(texto), { 'E-01': 'sim', 'E-02': 'não' })

  // A prova de que a defesa importa: lendo o jsonl INTEIRO, o enunciado
  // contribuiria ids sem veredito e a corrida mudaria de resultado.
  assert.ok(jsonl.includes('E-03'), 'o enunciado desta fixture cita E-03')
  assert.ok(!('E-03' in parseVerdicts(texto)), 'E-03 veio do enunciado, não do avaliador')
})

test('o veredito que a TELA perdeu, o transcript devolve', () => {
  // Capturado ao vivo no ciclo 0 de 01/09: o avaliador respondendo sobre
  // trail-S2-1, e a mesma resposta depois de o TUI reescrever a linha.
  const daTela = 'VER E-01 simVERE-02sim 3não45sim'
  const doTranscript = JSON.stringify({
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'VER E-01 sim\nVER E-02 sim\nVER E-03 não\nVER E-04 sim\nVER E-05 sim' }]
    }
  })

  // `VER E-04 sim` virou `4` e `VER E-05 sim` virou `5sim`: nenhum dos dois casa,
  // porque parseVerdicts exige o `E-` antes do número. A corrida foi anulada por
  // "avaliador não julgou" DUAS vezes, sobre um avaliador que julgou certo.
  const perdidos = parseVerdicts(daTela)
  assert.ok(!('E-04' in perdidos), 'a fixture da tela não reproduz mais o colapso')
  assert.ok(!('E-05' in perdidos), 'a fixture da tela não reproduz mais o colapso')

  assert.deepEqual(parseVerdicts(evaluatorText(doTranscript)), {
    'E-01': 'sim',
    'E-02': 'sim',
    'E-03': 'não',
    'E-04': 'sim',
    'E-05': 'sim'
  })
})

test('transcript sem resposta do assistente não apaga o que a tela viu', () => {
  // O transcript é escrito em voo. Um arquivo que ainda não tem a resposta
  // devolve vazio, e vazio NÃO é veredito — o driver fica com a tela e diz isso
  // na saída.
  const soUsuario = JSON.stringify({ message: { role: 'user', content: 'VER E-01 sim' } })
  assert.equal(evaluatorText(soUsuario), '')
  assert.deepEqual(parseVerdicts(evaluatorText(soUsuario)), {})
})

test('evaluatorText aguenta content string, linha torta e jsonl vazio', () => {
  assert.equal(evaluatorText(''), '')
  assert.equal(evaluatorText('{nao é json}\n'), '')
  const misto = [
    '{quebrado',
    JSON.stringify({ message: { role: 'assistant', content: 'VER E-01 sim' } }),
    JSON.stringify({ type: 'summary' }),
    JSON.stringify({ message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'VER E-09 não' }] } })
  ].join('\n')
  // O bloco de raciocínio NÃO entra: o avaliador pensando alto sobre um critério
  // não é o veredito dele.
  assert.deepEqual(parseVerdicts(evaluatorText(misto)), { 'E-01': 'sim' })
})

test('o avaliador é REUSADO, e só a última rodada conta', () => {
  // O transcript do avaliador do ciclo 0 de 01/09 tinha CINCO avaliações
  // completas no mesmo arquivo. Lendo o arquivo inteiro, os últimos vereditos
  // vencem — e se a resposta da corrida atual ainda não estiver escrita, os
  // últimos são os da corrida ANTERIOR. Uma corrida pontuada com o veredito de
  // outra, e nada na saída acusando.
  const rodada = (pedido, resposta) =>
    [
      JSON.stringify({ message: { role: 'user', content: pedido } }),
      ...(resposta
        ? [JSON.stringify({ message: { role: 'assistant', content: [{ type: 'text', text: resposta }] } })]
        : [])
    ].join('\n')

  const anterior = rodada('Read the agent trail in trail-S3-0.txt', 'VER E-01 sim\nVER E-02 sim')

  // A corrida de AGORA já respondeu: vale o que ela disse.
  const respondida = [anterior, rodada('Read the agent trail in trail-S3-1.txt', 'VER E-01 não\nVER E-02 não')].join('\n')
  assert.deepEqual(parseVerdicts(evaluatorText(respondida)), { 'E-01': 'não', 'E-02': 'não' })

  // A corrida de AGORA ainda NÃO respondeu: vazio, não o veredito da anterior.
  const emVoo = [anterior, rodada('Read the agent trail in trail-S3-1.txt', null)].join('\n')
  assert.deepEqual(
    parseVerdicts(evaluatorText(emVoo)),
    {},
    'o veredito da corrida anterior vazou para a corrida atual'
  )
})

// ─── A rubrica: o que o avaliador realmente lê ────────────────────────────────

test('todo critério tem pergunta, e a pergunta é julgável', () => {
  // A rubrica morava só em docs/, que está no .gitignore: numa máquina
  // recém-clonada o avaliador abria um arquivo inexistente, e um avaliador sem
  // rubrica responde n/a em tudo — que o harness anula, e anular é repetir.
  for (const c of CRITERIA) {
    assert.ok(c.question, `${c.id} sem pergunta`)
    assert.ok(c.question.length > 40, `${c.id}: pergunta curta demais para julgar`)
    assert.ok(c.question.trim().endsWith('?') || c.question.includes('?'), `${c.id}: não é pergunta`)
  }
  assert.equal(CRITERIA.length, 10)
})

test('E-03 diz o que conta, e onde a contagem para', () => {
  // A redação antiga comportava duas leituras e a diferença valia 60 pontos: o
  // avaliador do ciclo 0 contou o TOTAL de chamadas e reprovou 9 de 9; contando
  // até a primeira ação, seis das nove passariam. E a chamada com que o Claude
  // Code carrega a skill entrava na conta, o que tornava o critério impossível —
  // caminho mínimo de três contra teto de dois.
  const q = CRITERIA.find((c) => c.id === 'E-03').question
  assert.match(q, /PARANDO na primeira chamada/, 'não diz onde a contagem para')
  assert.match(q, /NÃO conte o carregamento da skill/, 'a carga da skill voltou para a conta')
  assert.match(q, /Skill/, 'não nomeia a ferramenta que não conta')
  assert.match(q, /duas chamadas ou menos/, 'perdeu o teto')
  // E não voltou a ser a frase ambígua de antes.
  assert.ok(
    !/contadas do prompt do usuário/.test(q),
    'a redação ambígua do ciclo 0 voltou'
  )
})

test('a rubrica escrita cobre todo critério que algum cenário aplica', () => {
  // O avaliador recebe a lista de ids aplicáveis e a rubrica; um id aplicável
  // sem verbete na rubrica é um `n/a` garantido, e um `n/a` num aplicável é o
  // que anula a corrida.
  const naRubrica = new Set(CRITERIA.map((c) => c.id))
  for (const s of SCENARIOS) {
    for (const id of s.applicable) {
      assert.ok(naRubrica.has(id), `${s.id} aplica ${id}, que não está na rubrica`)
    }
  }
})

// ─── A medida sem teto: chamadas até concluir ─────────────────────────────────

test('o esforço é agrupado por cenário, e nunca somado entre cenários', () => {
  // S3 é ler um portal; S4 é fazer uma tarefa inteira e anotá-la. Uma média dos
  // dois não descreveria corrida nenhuma.
  const recs = [
    { outcome: 'scored', scenario: { id: 'S3' }, toolCalls: 3 },
    { outcome: 'scored', scenario: { id: 'S3' }, toolCalls: 5 },
    { outcome: 'scored', scenario: { id: 'S4' }, toolCalls: 41 }
  ]
  const e = effortByScenario(recs)
  assert.deepEqual(Object.keys(e).sort(), ['S3', 'S4'])
  assert.equal(e.S3.median, 4)
  assert.equal(e.S3.min, 3)
  assert.equal(e.S3.max, 5)
  assert.equal(e.S4.runs, 1)
  assert.equal(e.S4.median, 41)
})

test('mediana ímpar é o do meio; par é a média dos dois do meio', () => {
  const um = effortByScenario([{ outcome: 'scored', scenario: { id: 'X' }, toolCalls: 7 }])
  assert.equal(um.X.median, 7)
  const dois = effortByScenario([
    { outcome: 'scored', scenario: { id: 'X' }, toolCalls: 10 },
    { outcome: 'scored', scenario: { id: 'X' }, toolCalls: 15 }
  ])
  assert.equal(dois.X.median, 12.5)
  // A ordem de entrada não muda nada — a lista é ordenada antes.
  const fora = effortByScenario([
    { outcome: 'scored', scenario: { id: 'X' }, toolCalls: 15 },
    { outcome: 'scored', scenario: { id: 'X' }, toolCalls: 3 },
    { outcome: 'scored', scenario: { id: 'X' }, toolCalls: 9 }
  ])
  assert.equal(fora.X.median, 9)
  assert.deepEqual(fora.X.calls, [3, 9, 15])
})

test('corrida sem contagem de chamadas fica FORA da medida', () => {
  // `toolCalls` é null quando a trilha veio da tela — e a tela COLAPSA as
  // chamadas (`ran 3 shell commands`). Contar aquilo como esforço inventaria um
  // número baixo justamente na corrida menos confiável.
  const e = effortByScenario([
    { outcome: 'scored', scenario: { id: 'S3' }, toolCalls: null },
    { outcome: 'scored', scenario: { id: 'S3' } },
    { outcome: 'scored', scenario: { id: 'S3' }, toolCalls: 4 }
  ])
  assert.equal(e.S3.runs, 1)
  assert.deepEqual(e.S3.calls, [4])
})

test('aggregate publica o esforço junto com os critérios, e só das pontuadas', () => {
  const recs = [
    {
      outcome: 'scored',
      scenario: { id: 'S3', applicable: ['E-03'] },
      score: { yes: 0, applicable: 1 },
      verdicts: { 'E-03': 'não' },
      toolCalls: 5
    },
    // Nula não entra em nada: nem no score, nem no esforço.
    { outcome: 'null', scenario: { id: 'S3', applicable: ['E-03'] }, toolCalls: 99 }
  ]
  const t = aggregate(recs)
  assert.equal(t.scored, 1)
  assert.equal(t.nullified, 1)
  assert.deepEqual(t.effort.S3.calls, [5], 'a corrida nula entrou no esforço')
})

test('a linha de base do ciclo 0 continua reproduzível', () => {
  // Os números reais de 01/09, para uma mudança no cálculo não passar calada.
  const ciclo0 = [
    ['S2', 13], ['S2', 13], ['S2', 14],
    ['S3', 3], ['S3', 4], ['S3', 5],
    ['S4', 15], ['S4', 16], ['S4', 41]
  ].map(([id, n]) => ({ outcome: 'scored', scenario: { id }, toolCalls: n }))
  const e = effortByScenario(ciclo0)
  assert.equal(e.S2.median, 13)
  assert.equal(e.S3.median, 4)
  assert.equal(e.S4.median, 16)
  // A faixa do S4 é o sujeito que percebeu os cartões fictícios (cartão C7E1E1C4).
  assert.equal(e.S4.max, 41)
})

// ─── A árvore: atribuir o que a corrida mexeu ─────────────────────────────────

test('o porcelain -z é fatiado por NUL, e o renome consome DOIS campos', () => {
  // Saída real do `git status --porcelain -z --untracked-files=all`, capturada de
  // um repositório de teste com renome, acento e espaço. Quem trata todo campo
  // como uma entrada conta o nome ANTIGO do renome como arquivo mexido a mais.
  const z = [
    ' D acentuado-ção.txt',
    ' M mantido.txt',
    'R  renomeado.txt',
    'renomear.txt',
    '?? src-novo.ts',
    '?? sub/outro novo.txt'
  ].join('\0') + '\0'

  const paths = parseGitStatus(z)
  assert.deepEqual(paths, [
    'acentuado-ção.txt',
    'mantido.txt',
    'renomeado.txt',
    'src-novo.ts',
    'sub/outro novo.txt'
  ])
  assert.ok(!paths.includes('renomear.txt'), 'o nome antigo do renome entrou como entrada')
  assert.ok(paths.includes('renomeado.txt'), 'o nome novo do renome não entrou')
})

test('caminho com espaço e com acento sai inteiro, sem escape octal', () => {
  // O `--porcelain` SEM `-z` entrega `"acentuado-\\303\\247\\303\\243o.txt"`, e um
  // parser que não desfizesse o escape reportaria caminho que não existe. É por
  // isso que o driver usa `-z`.
  const paths = parseGitStatus(' M sub dir/com acento ção.ts\0')
  assert.deepEqual(paths, ['sub dir/com acento ção.ts'])
})

test('entrada vazia e lixo não viram caminho', () => {
  assert.deepEqual(parseGitStatus(''), [])
  assert.deepEqual(parseGitStatus('\0\0'), [])
  // Campo curto demais para ter caminho depois do `XY `.
  assert.deepEqual(parseGitStatus(' M \0'), [])
})

test('o delta atribui à corrida só o que apareceu NELA', () => {
  // Uma árvore que já começa suja continua medindo: o que interessa é o que a
  // corrida acrescentou. Sem isso, uma sessão com trabalho em curso não poderia
  // rodar o eval — ou atribuiria ao sujeito o que já estava lá.
  const antes = ['src/ja-estava.ts', 'scripts/tambem.mjs']
  const depois = ['src/ja-estava.ts', 'scripts/tambem.mjs', 'src/main/core/date-coding.ts']
  const d = treeDelta(antes, depois)
  assert.deepEqual(d.touched, ['src/main/core/date-coding.ts'])
  assert.deepEqual(d.resolved, [])
})

test('arquivo que a corrida LIMPOU sai como resolved, não como touched', () => {
  const d = treeDelta(['src/a.ts', 'src/b.ts'], ['src/a.ts'])
  assert.deepEqual(d.touched, [])
  assert.deepEqual(d.resolved, ['src/b.ts'])
})

test('árvore limpa antes e depois não atribui nada', () => {
  const d = treeDelta([], [])
  assert.deepEqual(d.touched, [])
  assert.deepEqual(d.resolved, [])
})

test('o caso real do ciclo 0 seria pego', () => {
  // Um sujeito do S4 criou src/main/core/date-coding.ts e mexeu em treze
  // chamadores, deixando o typecheck quebrado. A árvore estava LIMPA antes.
  const antes = []
  const depois = [
    'scripts/make-demo-workspace.mjs',
    'scripts/test-data-table.mjs',
    'src/main/core/coding.ts',
    'src/main/core/date-coding.ts',
    'src/main/core/models/app-state.ts'
  ]
  const d = treeDelta(antes, depois)
  assert.equal(d.touched.length, 5)
  assert.ok(d.touched.includes('src/main/core/date-coding.ts'))
})

console.log(`\n${passed} passaram, ${failed} falharam\n`)
process.exit(failed === 0 ? 0 : 1)
