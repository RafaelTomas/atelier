/**
 * Contas do Claude — os quatro pontos onde a comutação quebra em silêncio.
 *
 * O recurso inteiro é uma variável de ambiente: `CLAUDE_CONFIG_DIR`. Nenhum dos
 * casos abaixo dá erro visível quando quebra — o agente simplesmente sobe
 * logado como a pessoa errada, ou perde a conta que estava gravada. Por isso o
 * teste cobre a falha, não o caminho feliz:
 *
 *   1. A conta padrão NÃO define a variável (definir apontando para ~/.claude
 *      levaria o `claude` a procurar ~/.claude/.claude.json, que não existe).
 *   2. Um cofre com a chave CLAUDE_CONFIG_DIR não consegue trocar a conta.
 *   3. Conta apagada não derruba o terminal: ele cai na padrão.
 *   4. Um terminal gravado antes deste recurso volta na conta padrão, e o
 *      campo sobrevive ao round-trip de quem já o tem.
 *
 * Uso: node scripts/test-claude-accounts.mjs
 */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile, lstat, readlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as esbuild from 'esbuild'

const ROOT = resolve(import.meta.dirname, '..')

// ATELIER_HOME antes de importar o bundle: `paths` lê a variável na chamada,
// mas o store das contas escreve de verdade em disco — e não é o ~/.atelier do
// usuário que este teste pode sujar.
const home = await mkdtemp(join(tmpdir(), 'atelier-accounts-home-'))
process.env.ATELIER_HOME = home

const outdir = await mkdtemp(join(tmpdir(), 'atelier-accounts-'))
const outfile = join(outdir, 'accounts.mjs')
await esbuild.build({
  stdin: {
    contents: `
      export { claudeAccounts } from './src/main/core/claude/accounts.ts'
      export { buildTerminalEnv } from './src/main/core/terminal/terminal-manager.ts'
      export { persistence } from './src/main/core/persistence/persistence-manager.ts'
      export { paths, claudeHomeDir } from './src/main/core/persistence/paths.ts'
      export { decodeNodeContent, encodeNodeContent, makeTerminalContent } from './src/main/core/models/node-content.ts'
      export { terminalContentFromOpts } from './src/main/core/models/terminal-draft.ts'
      export { DEFAULT_CLAUDE_ACCOUNT_ID } from './src/shared/types.ts'
      // Funções puras do renderer: decidem se o seletor aparece e o que ele diz.
      export { isClaudeCommand, accountLabel } from './src/renderer/claude-accounts.ts'
    `,
    resolveDir: ROOT,
    loader: 'ts'
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  external: ['electron', 'node-pty'],
  outfile,
  logLevel: 'silent',
  alias: { '@shared': join(ROOT, 'src/shared') }
})

const mod = await import(pathToFileURL(outfile).href)
const { claudeAccounts, buildTerminalEnv, persistence, paths } = mod
const { decodeNodeContent, encodeNodeContent, makeTerminalContent, terminalContentFromOpts } = mod
const { DEFAULT_CLAUDE_ACCOUNT_ID, isClaudeCommand, accountLabel } = mod

let passed = 0
let failed = 0

async function test(name, fn) {
  try {
    await fn()
    passed++
    console.log(`  ok  ${name}`)
  } catch (err) {
    failed++
    console.log(`FAIL  ${name}\n      ${err.message}`)
  }
}

const TERMINAL_ID = '11111111-1111-4111-8111-111111111111'
const envFor = (extra) => buildTerminalEnv({ terminalId: TERMINAL_ID, serverPort: 0, ...extra })

console.log('\nContas do Claude\n')

// ─── 1. A conta padrão é a AUSÊNCIA da variável ───────────────────────────────

await test('conta padrão não define CLAUDE_CONFIG_DIR', async () => {
  await claudeAccounts.load()
  assert.equal(claudeAccounts.configDirFor(null), null)
  assert.equal(claudeAccounts.configDirFor(DEFAULT_CLAUDE_ACCOUNT_ID), null)
  const env = envFor({})
  assert.ok(!('CLAUDE_CONFIG_DIR' in env), 'a variável não pode existir na conta padrão')
})

await test('conta criada vira um CLAUDE_CONFIG_DIR próprio', async () => {
  const { account } = await claudeAccounts.create('Trabalho')
  const dir = claudeAccounts.configDirFor(account.id)
  assert.equal(dir, paths.claudeAccountDir(account.id))
  assert.equal(envFor({ claudeConfigDir: dir }).CLAUDE_CONFIG_DIR, dir)
  // E o dado está em arquivo próprio, não em preferences.json (que o app
  // nativo Swift regrava sem as chaves que não conhece).
  const raw = JSON.parse(await readFile(paths.claudeAccounts(), 'utf8'))
  assert.equal(raw.length, 1)
  assert.equal(raw[0].label, 'Trabalho')
})

// ─── 2. Um cofre não pode trocar a conta ──────────────────────────────────────

await test('cofre não sobrescreve CLAUDE_CONFIG_DIR', async () => {
  const mine = '/contas/minha'
  const env = envFor({
    claudeConfigDir: mine,
    extraEnv: { CLAUDE_CONFIG_DIR: '/contas/do-atacante', DATABASE_URL: 'postgres://x' }
  })
  assert.equal(env.CLAUDE_CONFIG_DIR, mine, 'o cofre trocou a conta do agente')
  assert.equal(env.DATABASE_URL, 'postgres://x', 'as chaves legítimas do cofre continuam passando')
})

await test('cofre não injeta a conta quando o terminal está na padrão', async () => {
  const env = envFor({ extraEnv: { CLAUDE_CONFIG_DIR: '/contas/do-atacante' } })
  // Sem conta escolhida a chave NÃO existia, então o laço a aceitaria: é o
  // caso em que a trava do `key in env` não protege. Aqui a defesa é outra —
  // o cofre é do usuário, e a conta padrão é o que ele já tinha sem o Atelier.
  // O teste existe para tornar essa escolha visível se alguém a mudar.
  assert.equal(env.CLAUDE_CONFIG_DIR, '/contas/do-atacante')
})

// ─── 3. Conta apagada não derruba o terminal ──────────────────────────────────

await test('conta removida cai na padrão, não em erro', async () => {
  const { account } = await claudeAccounts.create('Temporária')
  await claudeAccounts.remove(account.id, true)
  assert.equal(claudeAccounts.configDirFor(account.id), null)
  assert.equal(claudeAccounts.labelFor(account.id), 'Padrão (~/.claude)')
})

await test('remove(deleteFiles) apaga o diretório da conta', async () => {
  const { account } = await claudeAccounts.create('Descartável')
  const dir = paths.claudeAccountDir(account.id)
  await writeFile(join(dir, '.credentials.json'), '{}', 'utf8')
  await claudeAccounts.remove(account.id, true)
  await assert.rejects(() => lstat(dir))
})

await test('resolve aceita id e rótulo (o --account do recruit)', async () => {
  const { account } = await claudeAccounts.create('Pessoal')
  assert.equal(claudeAccounts.resolve('Pessoal')?.id, account.id)
  assert.equal(claudeAccounts.resolve('pessoal')?.id, account.id)
  assert.equal(claudeAccounts.resolve(account.id)?.id, account.id)
  assert.equal(claudeAccounts.resolve('default'), 'default')
  assert.equal(claudeAccounts.resolve('não existe'), null)
})

// ─── Herança do ~/.claude ─────────────────────────────────────────────────────

await test('perfil novo herda config por link e NÃO herda credencial', async () => {
  const fakeHome = await mkdtemp(join(tmpdir(), 'fake-claude-'))
  await writeFile(join(fakeHome, 'settings.json'), '{"model":"opus"}', 'utf8')
  await mkdir(join(fakeHome, 'skills'), { recursive: true })
  await writeFile(join(fakeHome, '.credentials.json'), '{"token":"segredo"}', 'utf8')
  await writeFile(join(fakeHome, 'history.jsonl'), 'linha\n', 'utf8')

  const dir = join(outdir, 'perfil')
  const warnings = await persistence.createClaudeAccountDir(dir, fakeHome)
  assert.deepEqual(warnings, [], 'não deveria haver aviso num sistema com symlink')

  assert.ok((await lstat(join(dir, 'settings.json'))).isSymbolicLink())
  assert.equal(await readlink(join(dir, 'settings.json')), join(fakeHome, 'settings.json'))
  assert.ok((await lstat(join(dir, 'skills'))).isSymbolicLink())

  // O que NÃO pode ser herdado — é o ponto inteiro de existirem duas contas.
  await assert.rejects(() => lstat(join(dir, '.credentials.json')))
  await assert.rejects(() => lstat(join(dir, 'history.jsonl')))
  // 'commands' não existe no home falso: ausente lá, ausente aqui.
  await assert.rejects(() => lstat(join(dir, 'commands')))

  // Apagar a conta não pode levar junto o ~/.claude do outro lado do link.
  await persistence.deleteClaudeAccountDir(dir)
  assert.equal(await readFile(join(fakeHome, 'settings.json'), 'utf8'), '{"model":"opus"}')
  await rm(fakeHome, { recursive: true, force: true })
})

await test('readClaudeProfile lê o e-mail do .claude.json da conta', async () => {
  const dir = join(outdir, 'perfil-logado')
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, '.claude.json'),
    JSON.stringify({ oauthAccount: { emailAddress: 'eu@exemplo.com', organizationType: 'claude_max' } }),
    'utf8'
  )
  const semLogin = await persistence.readClaudeProfile(
    join(dir, '.claude.json'),
    join(dir, '.credentials.json')
  )
  assert.equal(semLogin.email, 'eu@exemplo.com')
  assert.equal(semLogin.plan, 'claude_max')
  assert.equal(semLogin.authenticated, false, 'sem .credentials.json não há login')

  await writeFile(join(dir, '.credentials.json'), '{}', 'utf8')
  const comLogin = await persistence.readClaudeProfile(
    join(dir, '.claude.json'),
    join(dir, '.credentials.json')
  )
  assert.equal(comLogin.authenticated, true)

  // Diretório vazio (conta recém-criada) não pode explodir a lista da UI.
  const vazio = await persistence.readClaudeProfile(join(dir, 'nada.json'), join(dir, 'nada'))
  assert.deepEqual(vazio, { email: null, plan: null, authenticated: false })
})

// ─── 4. O campo no nó de terminal ─────────────────────────────────────────────

await test('terminal gravado antes do recurso volta na conta padrão', () => {
  const legado = {
    terminal: { _0: { name: 'Claude', agentType: 'claude_code', command: 'claude' } }
  }
  const content = decodeNodeContent(legado)
  assert.equal(content.type, 'terminal')
  assert.equal(content.value.claudeAccountId, null)
})

await test('a conta sobrevive ao round-trip do workspace.json', () => {
  const content = {
    type: 'terminal',
    value: makeTerminalContent('Claude', { agentType: 'claude_code', claudeAccountId: 'abc-123' })
  }
  const back = decodeNodeContent(encodeNodeContent(content))
  assert.equal(back.value.claudeAccountId, 'abc-123')
})

// ─── Do diálogo até o nó ──────────────────────────────────────────────────────
// Este bloco existe por um bug real: a montagem do conteúdo a partir do
// rascunho era uma cópia manual da lista de campos, dentro do bridge (que
// importa `electron` e nenhum teste alcança). A conta escolhida no diálogo era
// descartada em silêncio e o terminal nascia na padrão.

await test('a conta escolhida no diálogo chega ao nó criado', async () => {
  await claudeAccounts.load()
  const { account } = await claudeAccounts.create('Do diálogo')
  const content = terminalContentFromOpts(
    { name: 'Claude', agentType: 'claude_code', command: 'claude', claudeAccountId: account.id },
    { roleExists: () => false, accountExists: (id) => claudeAccounts.has(id) }
  )
  assert.equal(content.claudeAccountId, account.id)
})

await test('conta inexistente vinda do renderer vira a padrão, não um id órfão', () => {
  const content = terminalContentFromOpts(
    { name: 'Claude', claudeAccountId: 'conta-que-nao-existe' },
    { roleExists: () => false, accountExists: (id) => claudeAccounts.has(id) }
  )
  assert.equal(content.claudeAccountId, null)
})

await test('todo campo do rascunho sobrevive à criação do nó', () => {
  // A trava contra a regressão original: um campo novo no TerminalDraft que
  // ninguém copiar aqui aparece como diferença, em vez de sumir calado.
  const draft = {
    name: 'Agente',
    command: 'claude',
    agentType: 'claude_code',
    workingDirectory: '/tmp/x',
    icon: 'burst',
    color: '#D97757',
    monitorWithOmbro: true,
    isManager: true,
    themeId: 'dark',
    fontFamily: 'Menlo, monospace',
    fontSize: 15,
    assignedRoleId: null,
    claudeAccountId: null
  }
  const content = terminalContentFromOpts(draft, {
    roleExists: () => true,
    accountExists: () => true
  })
  for (const [key, value] of Object.entries(draft)) {
    assert.deepEqual(content[key], value, `campo '${key}' não chegou ao nó`)
  }
})

// ─── Onde o seletor aparece ───────────────────────────────────────────────────

await test('o seletor de conta só aparece em terminal do Claude', () => {
  assert.equal(isClaudeCommand({ agentType: 'claude_code', command: '' }), true)
  // Digitado à mão num shell genérico: é justamente quando o tipo não ajuda.
  assert.equal(isClaudeCommand({ agentType: 'generic_shell', command: 'claude' }), true)
  assert.equal(isClaudeCommand({ agentType: 'generic_shell', command: '/usr/bin/claude --resume' }), true)
  assert.equal(isClaudeCommand({ agentType: 'codex', command: 'codex' }), false)
  assert.equal(isClaudeCommand({ agentType: 'generic_shell', command: '' }), false)
  // 'claudia' não é 'claude' — o seletor não pode aparecer em terminal alheio.
  assert.equal(isClaudeCommand({ agentType: 'generic_shell', command: 'claudia' }), false)
})

await test('o rótulo diz quando a conta ainda não tem login', () => {
  const base = { id: 'x', label: 'Trabalho', createdAt: '', configDir: '/x', plan: null }
  assert.equal(
    accountLabel({ ...base, email: 'eu@exemplo.com', authenticated: true }),
    'Trabalho — eu@exemplo.com'
  )
  assert.equal(accountLabel({ ...base, email: null, authenticated: false }), 'Trabalho — sem login')
})

await rm(outdir, { recursive: true, force: true })
await rm(home, { recursive: true, force: true })

console.log(`\n${passed} passaram, ${failed} falharam\n`)
process.exit(failed === 0 ? 0 : 1)
