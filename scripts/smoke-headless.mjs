/**
 * Smoke test do núcleo, SEM abrir janela.
 *
 * Exercita a fase 2 do porte de ponta a ponta: boot do estado, criação de
 * workspace, nós, conexões, servidor IPC e o protocolo real do `atelier`
 * falando por socket. Roda em CI, em qualquer um dos três sistemas.
 *
 * Uso: node scripts/smoke-headless.mjs
 */
import assert from 'node:assert/strict'
import net from 'node:net'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as esbuild from 'esbuild'

const ROOT = resolve(import.meta.dirname, '..')
const home = await mkdtemp(join(tmpdir(), 'atelier-smoke-'))
process.env.ATELIER_HOME = home
process.env.NODE_ENV = 'development'

let passed = 0
let failed = 0

async function test(name, fn) {
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

// Bundla o núcleo (TS) num módulo Node — `electron` fica externo e não é tocado
const outdir = await mkdtemp(join(tmpdir(), 'atelier-core-'))
const outfile = join(outdir, 'core.mjs')
await esbuild.build({
  stdin: {
    contents: `
      export { appState } from '${ROOT}/src/main/core/state/app-state.ts'
      export { interAgentServer } from '${ROOT}/src/main/core/interagent/server.ts'
      export { persistence } from '${ROOT}/src/main/core/persistence/persistence-manager.ts'
      export { ipcSocketPath, paths } from '${ROOT}/src/main/core/persistence/paths.ts'
      export { makeCanvasNode } from '${ROOT}/src/main/core/models/workspace.ts'
      export { makeTerminalContent, makeStickyNoteContent } from '${ROOT}/src/main/core/models/node-content.ts'
      export { roles } from '${ROOT}/src/main/core/state/role-store.ts'
      export { importLegacyDataIfNeeded } from '${ROOT}/src/main/core/persistence/import-legacy.ts'
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

const core = await import(pathToFileURL(outfile).href)
const { appState, interAgentServer, persistence, ipcSocketPath, paths } = core
const { makeCanvasNode, makeTerminalContent, makeStickyNoteContent } = core
const { roles } = core
const { importLegacyDataIfNeeded } = core

/** Fala o protocolo real do atelier por socket. */
function cli(args, terminalId) {
  return new Promise((resolvePromise, reject) => {
    const body = Buffer.from(JSON.stringify({ args }), 'utf8')
    const head =
      'POST /cli HTTP/1.0\r\n' +
      'Host: atelier\r\n' +
      `X-Terminal-ID: ${terminalId}\r\n` +
      'Content-Type: application/json\r\n' +
      `Content-Length: ${body.length}\r\n\r\n`

    const sock = net.createConnection(ipcSocketPath())
    const chunks = []
    sock.on('connect', () => {
      sock.write(head)
      sock.write(body)
    })
    sock.on('data', (c) => chunks.push(c))
    sock.on('error', reject)
    sock.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      const i = raw.indexOf('\r\n\r\n')
      resolvePromise(i >= 0 ? raw.slice(i + 4) : raw)
    })
  })
}

console.log('\nsmoke headless do núcleo\n')

// ─── Boot ─────────────────────────────────────────────────────────────────────

await test('servidor IPC sobe em socket + TCP', async () => {
  await interAgentServer.start()
  assert.ok(interAgentServer.port > 0, 'porta TCP não foi atribuída')
  assert.ok(existsSync(ipcSocketPath()), 'socket não foi criado')
})

await test('cold start cria manifest, preferences e workspace inicial', async () => {
  await appState.loadOnLaunch()
  assert.ok(existsSync(paths.manifest()))
  assert.ok(existsSync(paths.preferences()))
  assert.ok(existsSync(paths.appState()))
  assert.equal(appState.manifest.workspaces.length, 1)
})

await test('cleanShutdown é marcado false durante a sessão', async () => {
  const data = await persistence.loadAppState()
  assert.equal(data.cleanShutdown, false)
})

// ─── Canvas ───────────────────────────────────────────────────────────────────

const ws = appState.activeWorkspace
let terminalId
let noteId

await test('adiciona nós de terminal e nota', () => {
  const terminal = makeCanvasNode(
    { x: 9900, y: 8600, width: 560, height: 360 },
    { type: 'terminal', value: makeTerminalContent('Agent A') }
  )
  const note = makeCanvasNode(
    { x: 10500, y: 8600, width: 260, height: 150 },
    { type: 'stickyNote', value: makeStickyNoteContent('Spec') }
  )
  ws.addNode(terminal)
  ws.addNode(note)
  terminalId = terminal.id
  noteId = note.id
  assert.equal(ws.nodes.length, 2)
  assert.ok(ws.isDirty, 'adicionar nó deve marcar dirty')
})

await test('conecta terminal ↔ nota com o kind certo', () => {
  const conn = ws.addConnection(terminalId, noteId)
  assert.ok(conn, 'conexão não foi criada')
  assert.equal(conn.kind, 'note')
  assert.equal(conn.nodeIdA, terminalId, 'terminal deve ser o lado A')
})

await test('par não conectável é recusado', () => {
  const text = makeCanvasNode(
    { x: 0, y: 0, width: 100, height: 40 },
    { type: 'text', value: { text: 'x', fontSize: 18, fontWeight: 'regular', color: '#000', alignment: 'left', fontFamily: 'sans' } }
  )
  ws.addNode(text)
  assert.equal(ws.addConnection(terminalId, text.id), null)
})

// ─── Persistência ─────────────────────────────────────────────────────────────

await test('autosave grava só workspaces sujos', async () => {
  const count = await appState.saveDirtyWorkspaces()
  assert.equal(count, 1)
  assert.equal(ws.isDirty, false, 'dirty deve ser limpo após gravar')
  assert.equal(await appState.saveDirtyWorkspaces(), 0, 'segunda passada não deve gravar nada')
})

await test('workspace relê do disco preservando nós e conexões', async () => {
  const reloaded = await persistence.loadWorkspace(ws.id)
  assert.equal(reloaded.nodes.length, 3)
  assert.equal(reloaded.connections.length, 1)
  assert.equal(reloaded.connections[0].kind, 'note')
})

// ─── Protocolo atelier ───────────────────────────────────────────────────────

await test('atelier debug responde pelo socket', async () => {
  const out = await cli(['debug'], terminalId)
  assert.match(out, /Atelier inter-agent server debug/)
  assert.match(out, new RegExp(`Server port: ${interAgentServer.port}`))
})

await test('atelier list mostra a nota conectada', async () => {
  const out = await cli(['list'], terminalId)
  assert.match(out, /Connected notes/)
  assert.match(out, /Spec/)
})

await test('atelier list de um terminal sem conexões avisa', async () => {
  const orphan = makeCanvasNode(
    { x: 0, y: 0, width: 100, height: 100 },
    { type: 'terminal', value: makeTerminalContent('Orphan') }
  )
  ws.addNode(orphan)
  const out = await cli(['list'], orphan.id)
  assert.match(out, /No connected agents/)
})

await test('atelier note write + read faz round-trip pelo arquivo .md', async () => {
  const written = await cli(['note', 'write', 'Spec', 'conteúdo de teste'], terminalId)
  assert.match(written, /Wrote/)
  const read = await cli(['note', 'read', 'Spec'], terminalId)
  assert.equal(read.trim(), 'conteúdo de teste')
})

await test('atelier note create cria nota já conectada', async () => {
  const out = await cli(['note', 'create', 'nota nova'], terminalId)
  assert.match(out, /Created note/)
  const list = await cli(['list'], terminalId)
  assert.match(list, /Note \d/)
})

await test('comando desconhecido não derruba o servidor', async () => {
  const out = await cli(['naoexiste'], terminalId)
  assert.match(out, /unknown command/)
  assert.match(await cli(['debug'], terminalId), /debug/)
})

await test('comando não portado responde de forma honesta', async () => {
  const out = await cli(['portal', 'info', 'x'], terminalId)
  assert.match(out, /ainda não implementado/)
})

// ─── Responsabilidades (agentes) ──────────────────────────────────────────────

let roleId

await test('responsabilidade nasce como arquivo próprio em roles/', async () => {
  const role = await roles.save({
    name: 'Frontend',
    icon: 'paintbrush',
    color: '#AF52DE',
    instructions: 'Você cuida do frontend. Revise acessibilidade antes de aprovar UI.',
    workspaceId: null
  })
  roleId = role.id
  assert.ok(existsSync(paths.roleFile(role.id)), 'arquivo da responsabilidade não foi criado')
  assert.equal(role.id, role.id.toUpperCase(), 'UUID precisa ser maiúsculo')
  assert.match(role.createdAt, /^\d{4}-\d{2}-\d{2}T[\d:]+Z$/, 'data precisa ser ISO8601 sem ms')
})

await test('responsabilidade relê do disco sem perder nada', async () => {
  const [reloaded] = await persistence.loadRoles()
  assert.equal(reloaded.name, 'Frontend')
  assert.equal(reloaded.icon, 'paintbrush')
  assert.equal(reloaded.workspaceId, null)
  assert.match(reloaded.instructions, /acessibilidade/)
})

await test('atelier role responde "nenhuma" antes de atribuir', async () => {
  const out = await cli(['role'], terminalId)
  assert.match(out, /No role assigned/)
})

await test('atelier role devolve as instruções do terminal', async () => {
  ws.updateContent(terminalId, (node) => {
    node.content.value.assignedRoleId = roleId
  })
  const out = await cli(['role'], terminalId)
  assert.match(out, /Responsabilidade: Frontend/)
  assert.match(out, /acessibilidade/)
})

await test('atelier role list mostra as globais', async () => {
  const out = await cli(['role', 'list'], terminalId)
  assert.match(out, /Frontend/)
  assert.match(out, /\[global\]/)
})

await test('responsabilidade de outro workspace não vaza no list', async () => {
  const other = await appState.createWorkspace('Outro', '')
  await roles.save({ name: 'Só do Outro', workspaceId: other.id })
  const out = await cli(['role', 'list'], terminalId)
  assert.ok(!out.includes('Só do Outro'), 'responsabilidade de outro workspace apareceu')
})

await test('subcomando desconhecido de role não derruba o servidor', async () => {
  assert.match(await cli(['role', 'naoexiste'], terminalId), /unknown subcommand/)
  assert.match(await cli(['debug'], terminalId), /debug/)
})

await test('apagar responsabilidade remove o arquivo', async () => {
  await roles.remove(roleId)
  assert.ok(!existsSync(paths.roleFile(roleId)), 'arquivo não foi apagado')
  assert.equal(roles.has(roleId), false)
})

await test('terminal com responsabilidade apagada não quebra o CLI', async () => {
  // O nó ainda aponta para o id órfão (quem limpa é o bridge, no processo main)
  const out = await cli(['role'], terminalId)
  assert.match(out, /No role assigned/)
})

// ─── Importação dos dados do app nativo ───────────────────────────────────────
// Código que copia dados do usuário: precisa de teste antes de rodar em máquina real.

await test('importa dados legados quando o diretório novo não existe', async () => {
  const legacy = await mkdtemp(join(tmpdir(), 'atelier-legacy-'))
  const target = join(await mkdtemp(join(tmpdir(), 'atelier-target-')), 'novo')

  await mkdir(join(legacy, 'workspaces', 'ABC'), { recursive: true })
  await mkdir(join(legacy, 'run'), { recursive: true })
  await mkdir(join(legacy, 'bin'), { recursive: true })
  await writeFile(join(legacy, 'manifest.json'), '{"marcador":1}')
  await writeFile(join(legacy, 'workspaces', 'ABC', 'workspace.json'), '{"marcador":2}')
  await writeFile(join(legacy, 'run', 'agent.sock'), 'lixo')
  await writeFile(join(legacy, 'bin', 'omaestri'), 'lixo')

  const result = await importLegacyDataIfNeeded({
    legacyDir: legacy,
    targetDir: target,
    respectHomeOverride: false
  })

  assert.equal(result.imported, true)
  assert.equal(readFileSync(join(target, 'manifest.json'), 'utf8'), '{"marcador":1}')
  assert.equal(
    readFileSync(join(target, 'workspaces', 'ABC', 'workspace.json'), 'utf8'),
    '{"marcador":2}'
  )
  assert.ok(existsSync(join(target, '.imported-from-open-maestri')), 'marcador não foi escrito')
  assert.ok(!existsSync(join(target, 'run')), 'run/ não deveria ser copiado')
  assert.ok(!existsSync(join(target, 'bin')), 'bin/ não deveria ser copiado')

  // É CÓPIA: o app nativo tem que continuar funcionando
  assert.ok(existsSync(join(legacy, 'manifest.json')), 'o original foi destruído')

  await rm(legacy, { recursive: true, force: true })
  await rm(target, { recursive: true, force: true })
})

await test('não importa por cima de um diretório que já existe', async () => {
  const legacy = await mkdtemp(join(tmpdir(), 'atelier-legacy-'))
  const target = await mkdtemp(join(tmpdir(), 'atelier-target-'))
  await writeFile(join(legacy, 'manifest.json'), '{"legado":1}')
  await writeFile(join(target, 'manifest.json'), '{"atual":1}')

  const result = await importLegacyDataIfNeeded({
    legacyDir: legacy,
    targetDir: target,
    respectHomeOverride: false
  })

  assert.equal(result.imported, false)
  assert.equal(readFileSync(join(target, 'manifest.json'), 'utf8'), '{"atual":1}')

  await rm(legacy, { recursive: true, force: true })
  await rm(target, { recursive: true, force: true })
})

await test('ATELIER_HOME definido bloqueia a importação (isolamento do dev)', async () => {
  const legacy = await mkdtemp(join(tmpdir(), 'atelier-legacy-'))
  await writeFile(join(legacy, 'manifest.json'), '{}')
  const result = await importLegacyDataIfNeeded({ legacyDir: legacy })
  assert.equal(result.imported, false)
  assert.match(result.reason ?? '', /ATELIER_HOME/)
  await rm(legacy, { recursive: true, force: true })
})

// ─── Shutdown ─────────────────────────────────────────────────────────────────

await test('shutdown grava tudo e marca cleanShutdown', async () => {
  await appState.shutdown()
  const data = await persistence.loadAppState()
  assert.equal(data.cleanShutdown, true)
})

interAgentServer.stop()
await rm(outdir, { recursive: true, force: true })
await rm(home, { recursive: true, force: true })

console.log(`\n${passed} passaram, ${failed} falharam\n`)
process.exit(failed === 0 ? 0 : 1)
