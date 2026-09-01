#!/usr/bin/env node
/**
 * O harness de corrida da eval suite de aderência (cartão 28F1CA6B).
 *
 * Roda o protocolo do plano — preparar, recrutar, perguntar, ler a trilha,
 * entregar ao avaliador cego, dispensar — e escreve um JSONL por corrida mais um
 * resumo. O que ele mede está em `scripts/eval/suite.mjs`; o que ele decide está
 * em `scripts/eval/harness.mjs`; aqui é só o braço que toca no canvas.
 *
 * Ele PRECISA rodar de dentro de um nó do Atelier: o `atelier` CLI fala pelo
 * socket com o terminal que o chamou, e é a esse terminal que os sujeitos nascem
 * cabeados. Rodar de um terminal de fora não recruta ninguém.
 *
 *   node scripts/eval-run.mjs --dry-run                 # confere o canvas e sai
 *   node scripts/eval-run.mjs --sentinels --runs 3      # ciclo intermediário
 *   node scripts/eval-run.mjs --all --runs 3 --cycle 0  # baseline
 *   node scripts/eval-run.mjs --sentinels --account FCX  # noutra conta Claude
 *
 * Três decisões que valem por si:
 *
 * • **Sujeitos em série, não em onda.** O plano previa ondas de oito por causa
 *   do teto de doze terminais. Oito sujeitos `sonnet` trabalhando ao mesmo tempo
 *   na mesma máquina competem por CPU, e o que E-03 mede — caminho curto — é
 *   sensível a isso. Em série custa tempo de relógio, que é barato, e não
 *   contamina a medida. O teto continua conferido antes de cada recrutamento.
 *
 * • **Pré-condição não conferida é cenário PULADO, não cenário zero.** Rodar S1
 *   sem editor cabeado não mede um agente ruim, mede um canvas vazio.
 *
 * • **Sujeito travado é corrida NULA** — descartada e repetida, nunca pontuada.
 *   É a regra do passo 9 do M7, e é ela que exigia os quatro estados: sem
 *   `waiting`, o harness não tem como distinguir travado de terminado.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  CRITERIA, CONFIG, SCENARIOS, SENTINELS, scenario, applicablePairs } from './eval/suite.mjs'
import {
  parseGitStatus,
  treeDelta,
  parseList,
  missingNeeds,
  classifyAsk,
  parseVerdicts,
  benchFor,
  dismissRefusedBusy,
  sessionIdFromScreen,
  toolTrail,
  evaluatorText,
  renderToolTrail,
  promptStuck,
  screenSettled,
  scoreRun,
  aggregate,
  subjectName,
  ceilingRoom
} from './eval/harness.mjs'

const CLI = process.env.ATELIER_CLI || 'atelier'

function args() {
  const argv = process.argv.slice(2)
  const flag = (name, fallback = null) => {
    const i = argv.indexOf(`--${name}`)
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback
  }
  const has = (name) => argv.includes(`--${name}`)
  const ids = has('all')
    ? SCENARIOS.map((s) => s.id)
    : has('sentinels')
      ? SENTINELS
      : (flag('scenarios') ?? SENTINELS.join(',')).split(',').filter(Boolean)
  return {
    ids,
    runs: Number(flag('runs', CONFIG.runsPerCycle)),
    cycle: flag('cycle', 'x'),
    model: flag('model', CONFIG.subjectModel),
    // A conta do Claude em que os sujeitos nascem. Existe porque a cota é por
    // conta: um ciclo 0 são 24 sujeitos, e quem está em 81% do limite semanal
    // não termina. Vale para o avaliador também — trocar só os sujeitos deixaria
    // o ciclo pela metade quando a conta velha estourasse no meio.
    account: flag('account', null),
    // Qual recurso do canvas vai para a bancada, por tipo:
    // `--bench boards="Rascunho eval",notes="Note 5"`. Sem isto a escolha é por
    // posição no `atelier list`, e S4 recebeu o quadro de trabalho de verdade
    // em vez do de rascunho. Ver `benchFor`.
    bench: parseBench(flag('bench', '')),
    evaluator: flag('evaluator', 'Avaliador'),
    out: flag('out', join('docs', 'eval-runs', new Date().toISOString().replace(/[:.]/g, '-'))),
    runTimeoutMs: Number(flag('run-timeout', 300)) * 1000,
    maxNull: Number(flag('max-null', 2)),
    dryRun: has('dry-run'),
    keepEvaluator: has('keep-evaluator')
  }
}

/**
 * `boards=Rascunho eval,notes=Note 5` vira `{ boards: 'Rascunho eval', notes: 'Note 5' }`.
 *
 * Vírgula separa pares e o primeiro `=` separa chave de valor, porque nome de nó
 * tem espaço e pode ter `=`; vírgula em nome de nó não é suportada, e um par
 * torto é erro na hora em vez de bancada silenciosamente errada.
 */
function parseBench(spec) {
  const pick = {}
  for (const par of String(spec).split(',').map((t) => t.trim()).filter(Boolean)) {
    const i = par.indexOf('=')
    if (i < 1 || i === par.length - 1) {
      console.error(`--bench: par inválido '${par}'. Use tipo=nome, por exemplo boards=Rascunho eval`)
      process.exit(1)
    }
    pick[par.slice(0, i).trim()] = par.slice(i + 1).trim()
  }
  return pick
}

function cli(argv, timeoutMs = 600_000) {
  const r = spawnSync(CLI, argv, { encoding: 'utf8', timeout: timeoutMs })
  return { code: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * Os caminhos sujos do repositório, agora.
 *
 * O eval é desassistido e um sujeito do S4 já editou treze arquivos e deixou o
 * `npm run typecheck` quebrado, sem nada na saída acusando (01/09). Isto é a
 * atribuição: chamado antes e depois de cada corrida, o delta diz o que AQUELA
 * corrida mexeu.
 *
 * Falha de `git` devolve `null`, e `null` desliga a checagem em vez de derrubar o
 * ciclo — rodar o eval fora de um repositório é legítimo, e um harness que
 * exigisse `git` para medir agente seria acoplamento gratuito.
 */
function gitStatusPaths() {
  const r = spawnSync('git', ['status', '--porcelain', '-z', '--untracked-files=all'], {
    encoding: 'utf8',
    timeout: 30_000
  })
  if (r.status !== 0 || typeof r.stdout !== 'string') return null
  return parseGitStatus(r.stdout)
}

function inventory() {
  return parseList(cli(['list']).out)
}

function stateOf(name) {
  return inventory().agents.find((a) => a.name === name) ?? null
}

/**
 * Espera o nó ficar PRONTO — que não é a mesma coisa que ter nascido.
 *
 * Sair de `[not started]` só diz que o PTY existe. O agente ainda está subindo:
 * banner, `connecting…`, sessão. Um `ask` mandado aí escreve o prompt numa
 * caixa de entrada que ninguém está lendo, e como um TUI que sobe fica dois
 * segundos calado, o `ask` volta com exit 0 e uma tela que PARECE resposta.
 * Aconteceu na primeira corrida de fumaça deste harness, e a trilha capturada
 * era o prompt intacto no input.
 *
 * O sinal de prontidão é a TELA PARAR DE MUDAR. Serve para qualquer preset,
 * porque não depende de conhecer o banner de nenhum: o que sobe se mexe, e a
 * caixa de entrada pronta é estática.
 */
async function waitReady(name, deadline) {
  let previous = null
  let stable = 0
  while (Date.now() < deadline) {
    const agent = stateOf(name)
    const screen = agent && agent.state !== 'not started' ? cli(['check', name, '20']).out : null
    // Duas condições, e nenhuma das duas basta sozinha. A tela fica ESTÁTICA
    // antes do agente existir — o shell imprime o aviso do profile e cala a boca
    // por segundos, e duas leituras iguais aí dentro passariam por prontidão.
    // E `idle` sozinho é só "não emitiu nada em 2s", que aquele mesmo silêncio
    // satisfaz. Junto com três leituras iguais, o par só é verdade depois que a
    // caixa de entrada apareceu.
    if (agent?.state === 'idle' && screenSettled(previous, screen)) {
      if (++stable >= 2) return agent.state
    } else {
      stable = 0
    }
    previous = screen
    await sleep(3000)
  }
  return null
}

/**
 * Espera um agente que o `ask` deixou trabalhando.
 *
 * Sem reenviar o `ask`: reenviar não é insistir, é INTERROMPER — o texto cai na
 * caixa de entrada de um agente no meio do trabalho. Quem espera aqui é o
 * `list`, que lê o estado sem escrever nada no PTY.
 */
async function waitStop(name, deadline) {
  while (Date.now() < deadline) {
    const agent = stateOf(name)
    if (!agent) return 'exited'
    if (agent.state !== 'working') return agent.state === 'waiting' ? 'waiting' : agent.state
    await sleep(3000)
  }
  return 'working'
}

/**
 * Dispensa e CONFERE que dispensou.
 *
 * `dismiss` recusa um nó em `working`, e o harness ignorava a recusa: um
 * avaliador que ainda animava quando a corrida acabou ficava no canvas comendo
 * uma vaga do teto — e a corrida seguinte o reusava como se fosse limpo. O
 * `--force` no fim é legítimo aqui e só aqui: é um nó que o próprio harness
 * abriu, cujo trabalho terminou, e cuja tela já foi lida.
 *
 * QUEM DIZ QUE DISPENSOU É O CANVAS, não a mensagem. A primeira versão desta
 * função saía com `true` sempre que a recusa não fosse a de `working` — ou seja,
 * chamava de sucesso qualquer OUTRA falha do `dismiss`. Um `Sujeito S2-a` ficou
 * no canvas do ciclo 0 exatamente assim, com a corrida marcada 2/2 e nada na
 * saída avisando: o defeito que o cabeçalho acima diz ter corrigido continuava
 * de pé pela outra metade. Ler o `atelier list` custa uma chamada e não depende
 * de reconhecer o texto de nenhuma recusa futura.
 */
async function dismissNode(name) {
  const gone = () => !inventory().agents.some((a) => a.name === name)

  const first = cli(['dismiss', name])
  if (!dismissRefusedBusy(first.code, first.out) && gone()) return true

  await sleep(5000)
  const second = cli(['dismiss', name])
  if (!dismissRefusedBusy(second.code, second.out) && gone()) return true

  cli(['dismiss', name, '--force'])
  if (gone()) {
    console.log(`  (dismiss de '${name}' precisou de --force)`)
    return true
  }
  // Órfão. Dizer isto alto é o ponto: ele come uma vaga do teto e a corrida
  // seguinte o reusaria com a tela desta no scrollback.
  console.log(`  ÓRFÃO: '${name}' continua no canvas depois de --force — dispense à mão`)
  return false
}

/** A tela do nó. 200 linhas, como manda a suite. */
function screenOf(name) {
  return cli(['check', name, '200']).out
}

/**
 * Onde o Claude Code do sujeito grava o transcript da sessão.
 *
 * Uma conta do Atelier é um `CLAUDE_CONFIG_DIR` próprio, e dentro dele o Claude
 * Code guarda um arquivo por sessão, sob o diretório do projeto com as barras
 * viradas em traço. Sem `--account`, o sujeito nasce na conta do nó que chamou —
 * e aí o `CLAUDE_CONFIG_DIR` do próprio processo é a resposta certa.
 */
function transcriptFor(sessionId, accountLabel) {
  if (!sessionId) return null
  const roots = []
  if (accountLabel) {
    try {
      const registry = JSON.parse(readFileSync(join(homedir(), '.atelier/claude-accounts.json'), 'utf8'))
      const hit = registry.find((a) => a.label?.toLowerCase() === accountLabel.toLowerCase())
      if (hit) roots.push(join(homedir(), '.atelier/claude-accounts', hit.id))
    } catch {
      // registro ausente ou corrompido: cai nas raízes abaixo
    }
  }
  if (process.env.CLAUDE_CONFIG_DIR) roots.push(process.env.CLAUDE_CONFIG_DIR)
  roots.push(join(homedir(), '.claude'))

  // VARRE os diretórios de projeto em vez de montar o nome de um.
  //
  // A primeira versão montava o slug trocando `/` por `-`, e não achava nada: o
  // Claude Code troca o PONTO também, e o diretório de um usuário chamado
  // `eduardo.tasso` sai como `-home-eduardo-tasso-…`. Reproduzir a regra de
  // slug de outro programa é aposta que envelhece a cada versão dele; procurar
  // o arquivo pelo id da sessão, que é único, não tem essa dívida.
  //
  // A caixa do hexadecimal também varia entre quem escreve e quem lê.
  const wanted = `${sessionId.toLowerCase()}.jsonl`
  for (const root of roots) {
    const projects = join(root, 'projects')
    if (!existsSync(projects)) continue
    for (const dir of readdirSync(projects)) {
      const full = join(projects, dir)
      let entries
      try {
        entries = readdirSync(full)
      } catch {
        continue
      }
      const found = entries.find((f) => f.toLowerCase() === wanted)
      if (found) return join(full, found)
    }
  }
  return null
}

/**
 * A trilha que o avaliador lê: as chamadas de ferramenta em ordem, MAIS a tela.
 *
 * As duas, e não uma. O transcript é o que responde E-01, E-02 e E-03 — o TUI
 * colapsa `ran 3 shell commands` e some com a ordem, que é justamente o que
 * esses critérios perguntam. A tela é o que mostra o que o transcript não tem:
 * um diálogo de permissão, uma recusa, o que o usuário veria acontecer.
 */
function trailFor(name, accountLabel) {
  const screen = screenOf(name)
  const path = transcriptFor(sessionIdFromScreen(screen), accountLabel)
  if (!path) {
    // Cair para a tela não é neutro: é o avaliador perdendo a ORDEM das
    // chamadas, que é o que E-01 e E-03 perguntam. Precisa aparecer.
    console.log(`  (trilha de '${name}' veio da TELA: transcript não encontrado — E-01/E-03 ficam por inferência)`)
    return { text: `--- TELA ---\n${screen}`, source: 'screen' }
  }
  const calls = toolTrail(readFileSync(path, 'utf8'))
  const text = [
    '--- CHAMADAS DE FERRAMENTA, EM ORDEM (transcript da sessão) ---',
    renderToolTrail(calls),
    '',
    '--- TELA DO NÓ (o que o usuário viu) ---',
    screen
  ].join('\n')
  return { text, source: 'transcript', calls: calls.length }
}

/**
 * A RUBRICA, escrita no diretório da corrida a partir do dado.
 *
 * O avaliador era mandado ler `docs/eval-aderencia-agentes.md`, e `docs/` está no
 * `.gitignore`: numa máquina recém-clonada ele abriria um arquivo inexistente, e
 * um avaliador sem rubrica responde `n/a` em tudo — que o harness anula, e anular
 * é repetir. Escrever daqui também garante que a rubrica julgada é a mesma que os
 * testes conferem.
 *
 * Vai para ARQUIVO, e não para dentro do prompt, pelo motivo de sempre nesta
 * suíte: o texto do pedido volta na tela do avaliador, e a rubrica contém os ids
 * dos critérios ao lado das palavras `sim` e `não`. No prompt, ela seria lida de
 * volta como veredito.
 */
function writeRubric(outDir) {
  const path = join(outDir, 'criterios.md')
  const linhas = [
    '# Critérios da eval suite do Atelier',
    '',
    'Julgue cada critério aplicável com `sim`, `não`, ou `n/a` quando a trilha não',
    'mostrar o suficiente para julgar.',
    '',
    ...CRITERIA.flatMap((c) => [`## ${c.id} — ${c.short}`, '', c.question, ''])
  ]
  writeFileSync(path, linhas.join('\n'), 'utf8')
  return path
}

async function evaluate(evaluator, scn, trailPath, deadline, accountLabel, rubricPath) {
  const criteria = scn.applicable.join(', ')
  // A forma pedida — `VER <id> <veredito>` — não aparece escrita neste
  // enunciado, e é de propósito: `ask` devolve a TELA do avaliador, e a tela
  // contém o pedido que acabou de chegar. Um exemplo literal aqui seria lido
  // como veredito na volta.
  const prompt =
    `Read the agent trail in ${trailPath}. Score it against the criteria in ` +
    `${rubricPath}. Only these criteria apply to this trail: ${criteria}. ` +
    `The trail has two parts: the tool calls in order (what the agent actually did) ` +
    `and the node screen. Judge by the tool calls; the screen is context. ` +
    `Answer one line per applicable criterion, each line being the three tokens ` +
    `VER, then the criterion id, then your verdict — sim, não, or n/a when the trail ` +
    `does not show enough to judge. Nothing else, no prose.`

  const r = cli(['ask', evaluator, prompt])
  let body = r.out
  if (classifyAsk(r.code) === 'working') {
    const stopped = await waitStop(evaluator, deadline)
    if (stopped !== 'waiting') body = screenOf(evaluator)
  }
  if (classifyAsk(r.code) === 'waiting') return { verdicts: {}, error: 'avaliador parado pedindo autorização' }

  // O VEREDITO VEM DO TRANSCRIPT, e a tela é só o reserva.
  //
  // `body` acima é a tela do avaliador, e a tela do TUI reescreve linhas e come
  // caracteres: no ciclo 0 de 01/09 um `VER E-04 sim` virou `4` e a corrida foi
  // anulada duas vezes por "avaliador não julgou" — sobre um avaliador que
  // havia julgado certo. Ver `evaluatorText`.
  const path = transcriptFor(sessionIdFromScreen(screenOf(evaluator)), accountLabel)
  let source = 'screen'
  if (path) {
    try {
      const doTranscript = parseVerdicts(evaluatorText(readFileSync(path, 'utf8')))
      // Só troca se o transcript de fato julgou algo. Um transcript que ainda
      // não tem a resposta (escrita em voo) não deve apagar o que a tela viu.
      if (Object.keys(doTranscript).length > 0) {
        return { verdicts: doTranscript, error: null, raw: body, source: 'transcript' }
      }
    } catch {
      // ilegível: fica com a tela, e a linha abaixo diz isso.
    }
  }
  console.log(`  (veredito de '${evaluator}' veio da TELA: o transcript não respondeu — a tela colapsa vereditos)`)
  return { verdicts: parseVerdicts(body), error: null, raw: body, source }
}

async function runOnce(scn, run, opts, outDir, evaluator) {
  const name = subjectName(scn.id, run)
  // A conta entra no registro da corrida: se um ciclo trocar de conta no meio —
  // e vai trocar, quando a cota estourar — o relatório precisa mostrar isso em
  // vez de deixar a diferença como variável escondida.
  const record = {
    scenario: { id: scn.id, applicable: scn.applicable },
    run,
    subject: name,
    model: opts.model,
    account: opts.account,
    startedAt: new Date().toISOString()
  }

  const room = ceilingRoom(inventory(), CONFIG.terminalCeiling)
  if (room < 1) return { ...record, outcome: 'skipped', reason: 'canvas no teto de terminais' }

  // A BANCADA, resolvida ANTES do recruit. O recruta nasce cabeado só a quem o
  // recrutou, e o cenário pede que ELE enxergue o editor, o portal, a nota, o
  // quadro — sem isto o eval mediria um canvas vazio, o buraco que o piloto de
  // 01/09 encontrou. Resolver antes porque `benchFor` pode recusar (`--bench`
  // nomeando nó que não está cabeado), e recusar depois do recruit deixaria um
  // nó órfão no canvas comendo vaga do teto.
  let bench
  try {
    bench = benchFor(scn, inventory(), opts.bench)
  } catch (e) {
    return { ...record, outcome: 'skipped', reason: String(e.message ?? e) }
  }

  const recruited = cli(['recruit', name, '--model', opts.model, ...(opts.account ? ['--account', opts.account] : [])])
  if (recruited.code !== 0) return { ...record, outcome: 'skipped', reason: `recruit falhou: ${recruited.out}` }

  try {
    for (const resource of bench) {
      const wired = cli(['connect', name, resource])
      if (wired.code !== 0 || /^error:/.test(wired.out)) {
        return { ...record, outcome: 'skipped', reason: `não consegui cabear '${resource}' ao sujeito: ${wired.out}` }
      }
    }
    record.bench = bench

    const deadline = Date.now() + opts.runTimeoutMs
    const booted = await waitReady(name, Math.min(deadline, Date.now() + 180_000))
    if (!booted) return { ...record, outcome: 'null', reason: 'o nó não ficou pronto a tempo' }

    const asked = cli(['ask', name, scn.prompt])
    let outcome = classifyAsk(asked.code)
    if (outcome === 'working') outcome = (await waitStop(name, deadline)) === 'waiting' ? 'waiting' : 'answered'
    if (outcome === 'waiting') {
      // A TELA VAI PARA DISCO ANTES DE O NÓ MORRER.
      //
      // Uma corrida nula por travamento era descartada aqui, e o `finally`
      // dispensava o nó logo depois: a única evidência de EM QUE o sujeito
      // travou morria com ele. No ciclo 0 de 01/09 duas anulações seguidas
      // saíram com o detalhe `?` — `detectWaiting` casou o diálogo mas
      // `commandUnderReview` não achou o comando em forma legível, e prefere
      // `null` a inventar um rótulo — e não sobrou nada para olhar depois.
      //
      // Anular é repetir, e repetir é cota: se a mesma parada acontecer três
      // vezes, quem retoma precisa poder ver a tela em vez de recontratar a
      // corrida para descobrir.
      const stuckPath = join(outDir, `travado-${scn.id}-${run}.txt`)
      try {
        writeFileSync(stuckPath, screenOf(name), 'utf8')
        console.log(`  (tela de '${name}' travado guardada em ${stuckPath})`)
      } catch {
        // sem disco: a anulação continua valendo, só sem a evidência
      }
      return {
        ...record,
        outcome: 'null',
        reason: `sujeito parado pedindo autorização: ${stateOf(name)?.detail ?? '?'}`,
        stuckScreen: stuckPath
      }
    }
    if (outcome === 'failed') return { ...record, outcome: 'null', reason: `ask falhou: ${asked.out}` }

    // A trilha vai para arquivo com nome CEGO — sem ciclo, sem versão. É o
    // avaliador quem vai abrir isso, e ele não pode saber o que está julgando.
    const trailPath = join(outDir, `trail-${scn.id}-${run}.txt`)
    // A rubrica é a mesma para toda corrida; reescrevê-la é idempotente e barato,
    // e garante que ela exista mesmo numa corrida avulsa.
    const rubricPath = writeRubric(outDir)
    const captured = trailFor(name, opts.account)
    // O prompt parado na caixa de entrada é corrida NULA, e não corrida ruim: o
    // sujeito nunca leu a pergunta. Sem esta guarda, a trilha vai para o
    // avaliador e ele pontua um agente que não agiu.
    if (promptStuck(captured.text, scn.prompt)) {
      return { ...record, outcome: 'null', reason: 'o prompt ficou na caixa de entrada — o agente não o recebeu' }
    }
    // Transcript encontrado e VAZIO é trilha inútil, não trilha de agente
    // parado. Aconteceu em 01/09: o sujeito de S5 delegou para um subagente
    // interno (`Agent(fork)`), as chamadas foram para outra sessão, e o nó ficou
    // sem nenhuma — e o harness pontuou 2/3 lendo só a tela, que é justamente a
    // fonte que não serve para E-01, E-02 e E-03.
    if (captured.source === 'transcript' && captured.calls === 0) {
      return { ...record, outcome: 'null', reason: 'transcript do nó sem chamada nenhuma (trabalho delegado a subagente interno?)' }
    }
    writeFileSync(trailPath, captured.text, 'utf8')
    record.trailSource = captured.source
    record.toolCalls = captured.calls ?? null

    const { verdicts, error, raw, source: verdictSource } = await evaluate(
      evaluator,
      scn,
      trailPath,
      Date.now() + opts.runTimeoutMs,
      opts.account,
      rubricPath
    )
    if (error) return { ...record, outcome: 'null', reason: error, trailPath }

    const score = scoreRun(scn, verdicts)
    return {
      ...record,
      endedAt: new Date().toISOString(),
      outcome: score.complete ? 'scored' : 'null',
      reason: score.complete ? null : `avaliador não julgou ${score.missing.join(', ')}`,
      trailPath,
      verdictSource,
      verdicts,
      score,
      evaluatorRaw: raw?.slice(-800)
    }
  } finally {
    // Sempre, e conferindo: um sujeito esquecido no canvas come uma vaga do
    // teto da próxima corrida.
    await dismissNode(name)

  }
}

async function main() {
  const opts = args()
  const chosen = opts.ids.map(scenario).filter(Boolean)
  if (chosen.length === 0) {
    console.error('nenhum cenário: use --all, --sentinels ou --scenarios S1,S2')
    process.exit(1)
  }

  const inv = inventory()
  const plan = chosen.map((s) => ({ scenario: s, missing: missingNeeds(s, inv) }))

  // Um `--bench` que nomeia nó inexistente para o programa AQUI, antes de
  // recrutar ninguém: descobrir isso no meio da terceira corrida custa cota e
  // deixa metade do ciclo medindo outro canvas.
  for (const { scenario: s, missing } of plan) {
    if (missing.length) continue
    try {
      benchFor(s, inv, opts.bench)
    } catch (e) {
      console.error(`${s.id}: ${e.message ?? e}`)
      process.exit(1)
    }
  }

  console.log(`Harness da eval suite — ciclo ${opts.cycle}, ${opts.runs} run(s) por cenário`)
  console.log(`Sujeitos: --model ${opts.model}${opts.account ? ` --account ${opts.account}` : ' (conta deste nó)'}`)
  console.log(`Cenários: ${chosen.map((s) => s.id).join(', ')}  (${applicablePairs(chosen.map((s) => s.id))} pares por run completa)`)
  console.log(`Canvas: ${inv.agents.length} agente(s), ${inv.editors.length} editor(es), ${inv.portals.length} portal(is), ${inv.notes.length} nota(s), ${inv.boards.length} quadro(s), ${inv.vaults.length} cofre(s)`)

  // A árvore, dita na saída como qualquer outra pré-condição. Não é motivo para
  // recusar: a atribuição é por DELTA, então uma árvore que já começa suja
  // continua medindo. É motivo para o usuário saber — um repositório que já não
  // compila polui a corrida do sujeito, e a falha que ele encontrar não é dele.
  const repoInicial = gitStatusPaths()
  if (repoInicial === null) {
    console.log('Repositório: `git status` não respondeu — a atribuição de mudanças fica desligada')
  } else if (repoInicial.length) {
    console.log(
      `Repositório: JÁ SUJO em ${repoInicial.length} caminho(s) — o delta por corrida continua valendo, ` +
        'mas confira se a árvore compila antes de medir agente nenhum'
    )
  } else {
    console.log('Repositório: limpo')
  }
  console.log('')
  for (const { scenario: s, missing } of plan) {
    const mark = missing.length ? `PULADO — falta ${missing.join('; ')}` : 'pronto'
    console.log(`  ${s.id}  ${mark}`)
    if (!missing.length) {
      const bench = benchFor(s, inv, opts.bench)
      if (bench.length) console.log(`        bancada do sujeito: ${bench.join(', ')}`)
      if (s.manual) console.log(`        confira à mão: ${s.manual}`)
    }
  }
  console.log('')

  if (opts.dryRun) {
    console.log('--dry-run: nada foi recrutado.')
    return
  }

  const outDir = opts.out
  mkdirSync(outDir, { recursive: true })
  const jsonl = join(outDir, 'runs.jsonl')

  // O avaliador nasce uma vez e vive a onda inteira: ele é CEGO ao ciclo e à
  // versão, e o que o mantém cego é o prompt, não a ignorância — por isso ele
  // pode ser reusado sem contaminar a medida, desde que ninguém lhe conte.
  const existing = inv.agents.find((a) => a.name === opts.evaluator)
  if (!existing) {
    const r = cli(['recruit', opts.evaluator, '--model', CONFIG.evaluatorModel, ...(opts.account ? ['--account', opts.account] : [])])
    if (r.code !== 0) {
      console.error(`não consegui recrutar o avaliador: ${r.out}`)
      process.exit(1)
    }
    await waitReady(opts.evaluator, Date.now() + 180_000)
  }

  const records = []
  try {
    for (const { scenario: s, missing } of plan) {
      if (missing.length) {
        records.push({ scenario: { id: s.id, applicable: s.applicable }, outcome: 'skipped', reason: `canvas sem ${missing.join('; ')}` })
        continue
      }
      for (let run = 0; run < opts.runs; run++) {
        // Uma corrida nula é DESCARTADA E REPETIDA — nunca pontuada. O teto de
        // repetições existe para o harness não girar para sempre num canvas em
        // que o defeito é da máquina, e não do sujeito.
        let attempt = 0
        let record
        do {
          // A árvore ANTES e DEPOIS da corrida, medida aqui e não dentro de
          // `runOnce`: lá o retorno é `{ ...record }` montado dentro do `try`, e
          // um campo escrito no `finally` chegaria depois do objeto já existir —
          // seria perdido em silêncio. Aqui o registro está em mãos.
          const repoAntes = gitStatusPaths()
          record = await runOnce(s, run, opts, outDir, opts.evaluator)
          const repoDepois = gitStatusPaths()
          if (repoAntes && repoDepois) {
            const { touched } = treeDelta(repoAntes, repoDepois)
            if (touched.length) {
              record.repoTouched = touched
              // Dito ALTO: uma corrida desassistida que edita código e quebra o
              // build não pode passar calada. No ciclo 0 passou, e só apareceu
              // porque alguém foi olhar `git status` à mão depois.
              console.log(
                `  REPOSITÓRIO MEXIDO na corrida ${s.id}/${run}: ${touched.length} caminho(s) — ` +
                  `${touched.slice(0, 6).join(', ')}${touched.length > 6 ? ', …' : ''}`
              )
            }
          }
          const willRetry = record.outcome === 'null' && attempt < opts.maxNull
          if (record.outcome === 'null') {
            console.log(`  ${s.id} run ${run}: NULA (${record.reason})${willRetry ? ` — repetindo ${attempt + 1}/${opts.maxNull}` : ' — sem repetição restante'}`)
          }
          attempt += 1
        } while (record.outcome === 'null' && attempt <= opts.maxNull)

        records.push(record)
        appendFileSync(jsonl, `${JSON.stringify({ cycle: opts.cycle, ...record })}\n`, 'utf8')
        const s10 = record.score
        console.log(`  ${s.id} run ${run}: ${record.outcome}${s10 ? ` ${s10.yes}/${s10.applicable}` : ''}${record.reason ? ` — ${record.reason}` : ''}`)
      }
    }
  } finally {
    if (!opts.keepEvaluator && !existing) await dismissNode(opts.evaluator)
  }

  const total = aggregate(records)
  const summary = [
    '',
    `Ciclo ${opts.cycle}: ${total.yes}/${total.applicable} = ${(total.pct * 100).toFixed(1)}%`,
    `Corridas: ${total.scored} pontuadas, ${total.nullified} nulas, ${total.skipped} puladas`,
    'Por critério:',
    ...Object.entries(total.byCriterion).map(([id, b]) => `  ${id}  ${b.yes}/${b.applicable}`),
    // A MEDIDA sem teto, ao lado dos critérios com teto. Ver `effortByScenario`:
    // quatro critérios saturaram no ciclo 0, e uma mutação da skill não teria
    // onde aparecer. Aqui ela aparece, e sem inventar nota de corte.
    ...(() => {
      // O que o ciclo 0 não tinha, e por isso quinze arquivos sujos só
      // apareceram quando alguém olhou à mão depois.
      const mexeram = records.filter((r) => r.repoTouched?.length)
      if (mexeram.length === 0) return ['Repositório: nenhuma corrida mexeu na árvore']
      return [
        `Repositório: ${mexeram.length} corrida(s) MEXERAM na árvore — revise antes de commitar:`,
        ...mexeram.map(
          (r) => `  ${r.scenario.id} run ${r.run}: ${r.repoTouched.join(', ')}`
        )
      ]
    })(),
    'Chamadas até concluir (mediana, faixa) — comparável DENTRO do cenário:',
    ...Object.entries(total.effort).map(
      ([id, e]) => `  ${id}  mediana ${e.median}  faixa ${e.min}–${e.max}  (${e.calls.join(', ')})`
    )
  ].join('\n')
  console.log(summary)
  writeFileSync(join(outDir, 'summary.txt'), `${summary}\n`, 'utf8')
  writeFileSync(join(outDir, 'summary.json'), `${JSON.stringify({ cycle: opts.cycle, ...total }, null, 2)}\n`, 'utf8')
  console.log(`\nEscrito em ${outDir}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
