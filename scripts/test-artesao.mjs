/**
 * O Artesão: o settings gerado, a guarda do rascunho, a doutrina e a recusa.
 *
 * Tudo aqui é módulo puro — o esbuild empacota o núcleo sem Electron, como no
 * test-recruit. O que este arquivo NÃO cobre é o hook disparando de verdade
 * dentro do Claude Code; isso é verificação manual, e está no plano.
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as esbuild from 'esbuild'

const ROOT = resolve(import.meta.dirname, '..')

// ATELIER_HOME antes de qualquer import do núcleo, como no test-editor e no
// test-claude-accounts: `withAgentSettings` GRAVA o settings do terminal, e sem
// isto ele escreveria dentro do ~/.atelier real do usuário durante o teste.
const home = await mkdtemp(join(tmpdir(), 'atelier-artesao-home-'))
process.env.ATELIER_HOME = home

const outdir = await mkdtemp(join(tmpdir(), 'atelier-artesao-'))
const outfile = join(outdir, 'artesao.mjs')
await esbuild.build({
  stdin: {
    contents: `
      export { agentSettings, withAgentSettings } from './src/main/core/terminal/agent-settings.ts'
      export { statusLineBlock } from './src/main/core/terminal/status-line.ts'
      export { artisanDoctrine } from './src/main/core/interagent/artisan-doctrine.ts'
      export { terminalContentFromOpts } from './src/main/core/models/terminal-draft.ts'
      export { isClaudeCommandLine, isArtisanCapable } from './src/shared/terminal-presets.ts'
      export { ARTISAN_NAME, ARTISAN_ICON, ARTISAN_COLOR } from './src/shared/terminal-presets.ts'
      export { artisanBanner } from './src/main/core/interagent/artisan-doctrine.ts'
    `,
    resolveDir: ROOT,
    loader: 'ts'
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  external: ['electron'],
  outfile,
  logLevel: 'silent',
  alias: { '@shared': join(ROOT, 'src/shared') }
})

const {
  agentSettings,
  withAgentSettings,
  artisanDoctrine,
  terminalContentFromOpts,
  isClaudeCommandLine,
  isArtisanCapable,
  artisanBanner,
  ARTISAN_NAME,
  ARTISAN_ICON,
  ARTISAN_COLOR
} = await import(pathToFileURL(outfile).href)

// O CLI é CommonJS e mora fora do bundle: ele é copiado como arquivo único para
// ~/.atelier/bin, então não pode importar nada nosso. `require.main !== module`
// é o que deixa este teste olhar os textos dele sem executar o programa.
const require = createRequire(import.meta.url)
const cli = require(join(ROOT, 'resources/atelier.cjs'))

const TERMINAL_ID = 'AAAAAAAA-0000-0000-0000-0000000000AA'
const guards = { roleExists: () => true, accountExists: () => true }

let passed = 0
let failed = 0
function test(name, fn) {
  try {
    fn()
    passed++
    console.log(`  ok  ${name}`)
  } catch (err) {
    failed++
    console.error(`  FAIL ${name}`)
    console.error(`       ${err.message}`)
  }
}
async function testAsync(name, fn) {
  try {
    await fn()
    passed++
    console.log(`  ok  ${name}`)
  } catch (err) {
    failed++
    console.error(`  FAIL ${name}`)
    console.error(`       ${err.message}`)
  }
}

/**
 * O comando gravado no settings é o CLI por caminho inteiro — o `PATH` do PTY
 * pode ser reescrito pelo profile do usuário, e aí `atelier` resolveria para
 * outro binário (ver cli-install.ts). Asserta a FORMA, porque o caminho depende
 * do ATELIER_HOME do teste.
 */
function assertCliCommand(command, verb, msg) {
  assert.match(
    command,
    new RegExp(`^"[^"]*/bin/atelier" ${verb}$`),
    msg || `não é o CLI por caminho absoluto: ${command}`
  )
}

console.log('\nartesao\n')

// ─── O settings gerado ────────────────────────────────────────────────────────

test('sem Artesão a statusLine fica intacta e os quatro blocos entram', () => {
  const cfg = JSON.parse(agentSettings({ artisan: false }))
  assert.deepEqual(Object.keys(cfg), ['statusLine', 'hooks'], 'o Atelier mexeu em outra chave do usuário')
  assertCliCommand(cfg.statusLine.command, 'statusline')

  const start = cfg.hooks.SessionStart[0].hooks[0]
  assertCliCommand(start.command, 'brief', 'todo nó Claude Code devia ganhar o SessionStart do brief')

  // O bloqueio do Task DEIXOU de ser exclusivo do Artesão em 01/09. O que mudou
  // de ideia foi ver um nó comum abrir um `Agent(fork)` para executar uma tarefa
  // de canvas: o trabalho aconteceu noutra sessão, sem nó na tela, e o usuário
  // não teve o que olhar. O argumento nunca foi sobre o papel de quem delega.
  assertCliCommand(cfg.hooks.PreToolUse[0].hooks[0].command, 'artesao guard')
  assert.equal(cfg.hooks.PreToolUse[0].matcher, 'Task')
})

test('Artesão e nó comum têm os MESMOS hooks — o que difere é o brief', () => {
  const comum = JSON.parse(agentSettings({ artisan: false }))
  const artesao = JSON.parse(agentSettings({ artisan: true }))
  assert.deepEqual(comum.hooks, artesao.hooks)
})

test('sem argumento nenhum o padrão é não-Artesão', () => {
  assert.equal(agentSettings(), agentSettings({ artisan: false }))
})

test('com Artesão os hooks entram e a statusLine FICA', () => {
  const cfg = JSON.parse(agentSettings({ artisan: true }))
  assertCliCommand(cfg.statusLine.command, 'statusline', 'o monitor foi atropelado')

  // Mesmo com Artesão, o SessionStart chama `brief` — não `artesao brief`. A
  // doutrina entra como BLOCO da resposta de `brief` (handlers/brief.ts), e
  // não como um segundo hook concorrente.
  const start = cfg.hooks.SessionStart[0].hooks[0]
  assert.equal(start.type, 'command')
  assertCliCommand(start.command, 'brief')

  const pre = cfg.hooks.PreToolUse[0]
  assert.equal(pre.matcher, 'Task', 'o bloqueio não está mirando o subagente interno')
  assertCliCommand(pre.hooks[0].command, 'artesao guard')
})

// ─── A anexação do --settings ─────────────────────────────────────────────────

await testAsync('o --settings entra no Claude Code, com ou sem Artesão', async () => {
  for (const artisan of [true, false]) {
    const r = await withAgentSettings('claude', TERMINAL_ID, { artisan })
    assert.match(r.command, /^claude --settings "/)
    assert.ok(r.command.includes(TERMINAL_ID), 'o settings não é deste terminal')
  }
})

await testAsync('o settings é gravado sob o ATELIER_HOME, e não no ~/.atelier real', async () => {
  const r = await withAgentSettings('claude', TERMINAL_ID, { artisan: true })
  const path = r.command.match(/--settings "([^"]+)"/)[1]
  assert.ok(path.startsWith(home), `o teste escreveu fora do home isolado: ${path}`)
  const cfg = JSON.parse(await readFile(path, 'utf8'))
  assert.equal(cfg.hooks.PreToolUse[0].matcher, 'Task', 'o arquivo em disco não tem o bloqueio')
})

await testAsync('fora do Claude Code o Artesão não ganha hook nenhum', async () => {
  // Ele continua Artesão — o `ATELIER_ARTESAO` e o cabeçalho do `atelier list`
  // chegam nele — mas o comando sai intacto: não há `--settings` para pendurar.
  for (const cmd of ['codex', 'opencode --model x', 'agy', '']) {
    const r = await withAgentSettings(cmd, TERMINAL_ID, { artisan: true })
    assert.equal(r.command, cmd, `${cmd} foi alterado`)
  }
})

await testAsync('um --settings do usuário vence, mesmo custando o Artesão', async () => {
  const meu = 'claude --settings /meu/settings.json'
  const r = await withAgentSettings(meu, TERMINAL_ID, { artisan: true })
  assert.equal(r.command, meu)
})

// ─── A guarda do rascunho ─────────────────────────────────────────────────────

test('todo agente de IA pode ser Artesão; shell puro não', () => {
  for (const cmd of ['claude', 'codex', 'agy', 'opencode', '/usr/local/bin/claude --resume']) {
    assert.equal(
      terminalContentFromOpts({ command: cmd, isArtisan: true }, guards).isArtisan,
      true,
      `${cmd} deveria poder ser Artesão`
    )
  }
  // Shell puro: não há a quem instruir, e o badge seria enfeite.
  assert.equal(terminalContentFromOpts({ command: '', isArtisan: true }, guards).isArtisan, false)
  assert.equal(
    terminalContentFromOpts({ command: 'bash', isArtisan: true }, guards).isArtisan,
    false,
    'um shell nasceu Artesão'
  )
})

test('o agentType também abre a porta, para comando escrito à mão', () => {
  // O caso do `recruit --command`, e o do usuário que digitou o binário dele.
  assert.equal(
    isArtisanCapable({ agentType: 'codex', command: 'meu-codex-wrapper' }),
    true
  )
  assert.equal(isArtisanCapable({ agentType: 'generic_shell', command: 'bash' }), false)
  assert.equal(isArtisanCapable({ agentType: 'generic_shell', command: 'codex' }), true)
})

test('o bloqueio duro continua sendo só do Claude Code', () => {
  // A capacidade é larga; a FORÇA não. É o que o diálogo diz ao usuário, e é o
  // que decide se o settings com os hooks chega a ser escrito.
  assert.equal(isArtisanCapable({ agentType: 'codex', command: 'codex' }), true)
  assert.equal(isClaudeCommandLine('codex'), false)
})

test('o banner do list ensina o caminho sem despejar a doutrina inteira', () => {
  const banner = artisanBanner()
  assert.ok(banner.includes('atelier recruit'))
  assert.ok(banner.includes('atelier ask'))
  assert.ok(banner.includes('artesao brief'), 'não aponta para a doutrina completa')
  assert.ok(banner.split('\n').length <= 12, 'o banner cresceu demais para abrir todo `list`')
})

test('a identidade do Artesão é o martelo verde', () => {
  assert.equal(ARTISAN_NAME, 'Artesão')
  assert.equal(ARTISAN_ICON, 'hammer')
  assert.equal(ARTISAN_COLOR, '#34C759')
})

test('o diálogo e o main concordam sobre quem pode ser Artesão', () => {
  // O checkbox é habilitado por `isClaudeCommandLine(draft.command)`, e é a
  // MESMA função que decide o que se grava. Foi por divergirem que a conta do
  // Claude já se perdeu uma vez — ver o cabeçalho de models/terminal-draft.ts.
  for (const cmd of ['claude', 'claude --resume', 'codex', 'agy', 'opencode', '', 'bash']) {
    const habilitado = isArtisanCapable({ agentType: 'generic_shell', command: cmd })
    assert.equal(
      terminalContentFromOpts({ command: cmd, isArtisan: true }, guards).isArtisan,
      habilitado,
      `o gravado divergiu do habilitado em ${cmd || '(vazio)'}`
    )
  }
})

test('ausente ou não-booleano não liga o Artesão', () => {
  assert.equal(terminalContentFromOpts({ command: 'claude' }, guards).isArtisan, false)
  assert.equal(
    terminalContentFromOpts({ command: 'claude', isArtisan: 'sim' }, guards).isArtisan,
    false
  )
})

// ─── A doutrina ───────────────────────────────────────────────────────────────

test('a doutrina ensina o caminho do canvas', () => {
  const text = artisanDoctrine({ peers: [], slotsLeft: 9, boards: [] })
  for (const verb of ['atelier list', 'atelier recruit', 'atelier ask', 'atelier check']) {
    assert.ok(text.includes(verb), `a doutrina não menciona \`${verb}\``)
  }
  assert.ok(/9 more terminals/.test(text), 'o número de vagas não saiu')
  assert.ok(text.includes('Nobody is cabled to you yet'))
})

test('a doutrina nomeia quem já está no canvas', () => {
  const text = artisanDoctrine({ peers: ['Revisor', 'Backend'], slotsLeft: 1, boards: ['Sprint'] })
  assert.ok(text.includes('Revisor, Backend'))
  assert.ok(text.includes('Sprint'))
  assert.ok(/1 more terminal can/.test(text), 'o singular das vagas quebrou')
})

test('no teto, a doutrina manda dispensar em vez de recrutar', () => {
  const text = artisanDoctrine({ peers: ['A'], slotsLeft: 0, boards: [] })
  assert.ok(text.includes('ceiling for this canvas is reached'))
  assert.ok(!/0 more terminal/.test(text), 'ofereceu zero vagas como se fossem vagas')
})

// ─── A recusa, no CLI ─────────────────────────────────────────────────────────

test('a recusa do Task é JSON de hook válido, e ensina', () => {
  const out = JSON.parse(cli.artisanGuardResponse())
  const hook = out.hookSpecificOutput
  assert.equal(hook.hookEventName, 'PreToolUse')
  assert.equal(hook.permissionDecision, 'deny')
  assert.ok(hook.permissionDecisionReason.includes('atelier recruit'), 'a recusa não ensina')
  assert.ok(hook.permissionDecisionReason.includes('atelier ask'))
})

test('o brief é JSON de hook válido', () => {
  const hook = JSON.parse(cli.artisanBriefResponse('doutrina')).hookSpecificOutput
  assert.equal(hook.hookEventName, 'SessionStart')
  assert.equal(hook.additionalContext, 'doutrina')
})

test('o texto local do CLI serve de doutrina quando o app não responde', () => {
  assert.ok(cli.ARTISAN_REFUSAL.includes('atelier recruit'))
  // Não fala mais em "Artisan": a recusa chega a qualquer nó do canvas, e um
  // texto que diga "este terminal é um Artesão" para um nó comum mente.
  assert.ok(cli.ARTISAN_REFUSAL.includes('Atelier canvas'))
  assert.ok(!cli.ARTISAN_REFUSAL.includes('is an Artisan'))
})

await rm(outdir, { recursive: true, force: true })
await rm(home, { recursive: true, force: true })

console.log(`\n${passed} passaram, ${failed} falharam\n`)
process.exit(failed > 0 ? 1 : 0)
