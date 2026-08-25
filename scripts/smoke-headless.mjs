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
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
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
      export { appState } from './src/main/core/state/app-state.ts'
      export { interAgentServer } from './src/main/core/interagent/server.ts'
      export { persistence } from './src/main/core/persistence/persistence-manager.ts'
      export { ipcSocketPath, paths } from './src/main/core/persistence/paths.ts'
      export { makeCanvasNode } from './src/main/core/models/workspace.ts'
      export { makeTerminalContent, makeStickyNoteContent } from './src/main/core/models/node-content.ts'
      export { roles } from './src/main/core/state/role-store.ts'
      export { importLegacyDataIfNeeded } from './src/main/core/persistence/import-legacy.ts'
      export { scanAgentStatus } from './src/main/core/terminal/agent-status.ts'
      export { projectIndex } from './src/main/core/state/project-store.ts'
      export { scanForProjects } from './src/main/core/projects/scanner.ts'
      export { isRepository, inferKind } from './src/main/core/projects/detect.ts'
      export { isPathAllowed } from './src/main/core/projects/fs-access.ts'
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
const { scanAgentStatus } = core
const { projectIndex, scanForProjects, isRepository, inferKind, isPathAllowed } = core

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
  // No Windows o endereço é um named pipe, que não aparece no sistema de
  // arquivos: a prova de que subiu é conseguir abrir uma conexão nele.
  if (process.platform === 'win32') {
    await new Promise((ok, fail) => {
      const probe = net.createConnection(ipcSocketPath())
      probe.on('connect', () => {
        probe.end()
        ok()
      })
      probe.on('error', fail)
    })
  } else {
    assert.ok(existsSync(ipcSocketPath()), 'socket não foi criado')
  }
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

// ─── Linha de status do agente ────────────────────────────────────────────────
// Raspagem da tela: formato de terceiro, então tem que ter teste.

await test('lê a linha inteira do Claude Code, com ANSI no meio', () => {
  const line = '\x1b[2m. 31,3k tok . 3% . 5h:80% 7d:58%\x1b[0m'
  const s = scanAgentStatus(line)
  assert.equal(s.tokens, 31300, 'vírgula com sufixo k é decimal, não milhar')
  assert.equal(s.contextPct, 3)
  assert.deepEqual(s.limits, [
    { window: '5h', pct: 80 },
    { window: '7d', pct: 58 }
  ])
})

await test('separador decimal: pt-BR e en-US convivem', () => {
  assert.equal(scanAgentStatus('218.0k tok').tokens, 218000)
  assert.equal(scanAgentStatus('1.2M tokens').tokens, 1200000)
  assert.equal(scanAgentStatus('tokens used: 12,345').tokens, 12345, 'milhar en-US')
  assert.equal(scanAgentStatus('Total tokens: 1.234').tokens, 1234, 'milhar pt-BR')
})

await test('vale a ocorrência mais recente, não a primeira', () => {
  const s = scanAgentStatus('antes 100.0k tok . 9%\r\n\x1b[Kdepois 218.5k tok . 44%')
  assert.equal(s.tokens, 218500)
  assert.equal(s.contextPct, 44)
})

await test('o bloco de limites vem inteiro, não só a última janela', () => {
  const s = scanAgentStatus('velho 5h:10% 7d:20%\r\nnovo 5h:80% 7d:58%')
  assert.deepEqual(s.limits, [
    { window: '5h', pct: 80 },
    { window: '7d', pct: 58 }
  ])
})

await test('terminal sem linha de status não inventa número', () => {
  const s = scanAgentStatus('$ ls -la\r\ntotal 24\r\n')
  assert.equal(s.tokens, null)
  assert.equal(s.contextPct, null)
  assert.deepEqual(s.limits, [])
})

// ─── Projetos: varredura e índice ─────────────────────────────────────────────

/** Árvore sintética que exercita todas as regras de poda de uma vez. */
async function buildProjectTree() {
  const base = await mkdtemp(join(tmpdir(), 'atelier-projects-'))
  const repo = async (...parts) => {
    await mkdir(join(base, ...parts, '.git'), { recursive: true })
    await writeFile(join(base, ...parts, '.git', 'HEAD'), 'ref: refs/heads/main\n')
  }

  await repo('a')
  await writeFile(join(base, 'a', 'package.json'), JSON.stringify({ name: 'projeto-a', description: 'o projeto A' }))

  await repo('b')
  // Um repositório dentro de outro: a parada no .git tem de ignorá-lo
  await repo('b', 'sub')

  // node_modules tem package.json em cada pacote: sem poda vira ruído
  await mkdir(join(base, 'c', 'node_modules', 'x'), { recursive: true })
  await writeFile(join(base, 'c', 'node_modules', 'x', 'package.json'), '{"name":"dependencia"}')

  await repo('d', 'nested')
  await writeFile(join(base, 'd', 'nested', 'pom.xml'), '<project/>')

  // O ganho da regra: um repo com backend/ e frontend/ dentro é UM projeto
  await repo('mono')
  await mkdir(join(base, 'mono', 'backend'), { recursive: true })
  await writeFile(join(base, 'mono', 'backend', 'package.json'), '{"name":"backend"}')
  await mkdir(join(base, 'mono', 'frontend'), { recursive: true })
  await writeFile(join(base, 'mono', 'frontend', 'package.json'), '{"name":"frontend"}')

  // Pasta com manifesto e SEM repositório: não é projeto
  await mkdir(join(base, 'solto'), { recursive: true })
  await writeFile(join(base, 'solto', 'package.json'), '{"name":"solto"}')

  // Symlink apontando para o próprio topo: um walk ingênuo faz laço aqui
  try {
    await symlink(base, join(base, 'loop'), 'dir')
  } catch {
    // Windows sem privilégio de symlink: o resto do teste continua válido
  }
  return base
}

const projectTree = await buildProjectTree()

await test('scan acha projetos, poda node_modules e não entra em laço de symlink', async () => {
  const r = await scanForProjects({
    roots: [projectTree],
    descendRoots: true,
    maxDepth: 6,
    maxDurationMs: 20_000,
    maxDirs: 5000
  })
  const nomes = r.projects.map((p) => p.name).sort()
  assert.equal(r.stopped, 'done')
  // 'mono' entra uma vez só, e 'solto' (manifesto sem .git) não entra
  assert.deepEqual(nomes, ['a', 'b', 'mono', 'nested'])
  assert.ok(!nomes.includes('dependencia'), 'node_modules não foi podado')
  assert.ok(!nomes.includes('backend') && !nomes.includes('frontend'), 'sub-pasta virou entrada')
  // O nome é o da PASTA, nunca o do manifesto ('projeto-a' está no package.json de a/)
  assert.ok(!nomes.includes('projeto-a'), 'nome veio do manifesto')
})

await test('parada no marcador: projeto dentro de projeto não vira entrada', async () => {
  const r = await scanForProjects({
    roots: [join(projectTree, 'b')],
    maxDepth: 6,
    maxDurationMs: 20_000,
    maxDirs: 5000
  })
  assert.equal(r.projects.length, 1)
  assert.equal(r.projects[0].gitBranch, 'main')
})

await test('maxDepth corta a descida', async () => {
  const r = await scanForProjects({
    roots: [projectTree],
    descendRoots: true,
    maxDepth: 1,
    maxDurationMs: 20_000,
    maxDirs: 5000
  })
  // 'd/nested' está no nível 2 e não pode ser alcançado
  assert.ok(!r.projects.some((p) => p.name === 'nested'))
})

await test('cancelar durante o scan devolve parcial, não erro', async () => {
  const signal = { cancelled: false }
  const r = await scanForProjects({
    roots: [projectTree],
    descendRoots: true,
    maxDepth: 6,
    maxDurationMs: 20_000,
    maxDirs: 5000,
    signal,
    onProgress: () => {
      signal.cancelled = true
    }
  })
  assert.ok(r.stopped === 'cancelled' || r.stopped === 'done')
})

await test('só .git faz um diretório ser projeto', () => {
  const dirent = (name) => ({ name, isDirectory: () => false, isSymbolicLink: () => false })
  assert.equal(isRepository([dirent('package.json'), dirent('go.mod')]), false)
  assert.equal(isRepository([dirent('README.md'), dirent('.git')]), true)
})

await test('inferKind é só rótulo: nunca decide, e sempre responde algo', () => {
  const dirent = (name) => ({ name, isDirectory: () => false, isSymbolicLink: () => false })
  assert.deepEqual(inferKind([dirent('.git'), dirent('go.mod')]), { kind: 'go', language: 'go' })
  assert.deepEqual(inferKind([dirent('.git'), dirent('App.csproj')]), { kind: 'dotnet', language: 'csharp' })
  // Repositório sem manifesto reconhecido continua sendo projeto, com selo 'git'
  assert.deepEqual(inferKind([dirent('.git'), dirent('notas.txt')]), { kind: 'git', language: null })
  // Sem repositório: só a adição manual chega aqui
  assert.deepEqual(inferKind([dirent('notas.txt')]), { kind: 'folder', language: null })
})

await test('mergeScan preenche o índice e persiste', async () => {
  const r = await scanForProjects({
    roots: [projectTree],
    descendRoots: true,
    maxDepth: 6,
    maxDurationMs: 20_000,
    maxDirs: 5000
  })
  const summary = await projectIndex.mergeScan(r.projects, {
    roots: [projectTree],
    archiveMissing: true
  })
  assert.equal(summary.added, 4)
  assert.ok(existsSync(paths.projects()))
})

await test('re-scan preserva favorito e descrição do agente', async () => {
  const alvo = projectIndex.byName('a')
  assert.ok(alvo, 'projeto a não entrou no índice')
  await projectIndex.patch(alvo.id, { isFavorite: true })
  await projectIndex.describe(alvo.id, { description: 'escrito pelo agente', stack: ['React'] })

  const r = await scanForProjects({
    roots: [projectTree],
    descendRoots: true,
    maxDepth: 6,
    maxDurationMs: 20_000,
    maxDirs: 5000
  })
  const summary = await projectIndex.mergeScan(r.projects, {
    roots: [projectTree],
    archiveMissing: true
  })
  assert.equal(summary.added, 0, 're-scan duplicou projetos')

  const depois = projectIndex.byName('a')
  assert.equal(depois.isFavorite, true, 'favorito foi perdido')
  assert.equal(depois.description, 'escrito pelo agente', 'descrição do agente foi sobrescrita')
  assert.deepEqual(depois.stack, ['React'])
})

await test('projeto que sumiu é arquivado, nunca apagado', async () => {
  await rm(join(projectTree, 'a'), { recursive: true, force: true })
  const r = await scanForProjects({
    roots: [projectTree],
    descendRoots: true,
    maxDepth: 6,
    maxDurationMs: 20_000,
    maxDirs: 5000
  })
  const summary = await projectIndex.mergeScan(r.projects, {
    roots: [projectTree],
    archiveMissing: true
  })
  assert.equal(summary.archived, 1)
  const sumido = projectIndex.byName('a')
  assert.ok(sumido, 'projeto arquivado foi apagado do índice')
  assert.equal(sumido.isArchived, true)
  assert.equal(sumido.description, 'escrito pelo agente', 'arquivar perdeu o enriquecimento')
})

await test('scan cancelado nunca arquiva (ausência não foi provada)', async () => {
  const antes = projectIndex.all.filter((p) => p.isArchived).length
  const summary = await projectIndex.mergeScan([], {
    roots: [projectTree],
    archiveMissing: false
  })
  assert.equal(summary.archived, 0)
  assert.equal(projectIndex.all.filter((p) => p.isArchived).length, antes)
})

await test('projects.json sobrevive ao reload com UUID e datas no dialeto', async () => {
  await projectIndex.load()
  const p = projectIndex.byName('nested')
  assert.ok(p)
  assert.equal(p.id, p.id.toUpperCase(), 'UUID não está em maiúsculas')
  assert.match(p.createdAt, /^\d{4}-\d{2}-\d{2}T[\d:]+Z$/, 'data com milissegundos')
  const raw = JSON.parse(readFileSync(paths.projects(), 'utf8'))
  assert.equal(raw.type, 'projectIndex')
  assert.equal(raw.schemaVersion, 1)
})

await test('atelier projects list mostra o índice pelo socket', async () => {
  const out = await cli(['projects', 'list'], terminalId)
  assert.match(out, /project\(s\) in the index/)
  assert.match(out, /nested/)
})

await test('atelier projects --pending é a fila de trabalho do Scanner', async () => {
  const antes = await cli(['projects', 'list', '--pending'], terminalId)
  assert.match(antes, /awaiting a description/)

  const escrita = await cli(
    ['projects', 'describe', 'nested', 'Serviço Java de exemplo', '--stack', 'Java,Maven', '--role', 'api'],
    terminalId
  )
  assert.match(escrita, /Updated 'nested'/)

  const info = await cli(['projects', 'info', 'nested'], terminalId)
  assert.match(info, /Serviço Java de exemplo/)
  assert.match(info, /Java, Maven/)

  // e o descrito sai da fila
  const depois = await cli(['projects', 'list', '--pending'], terminalId)
  assert.ok(!depois.includes('nested'), 'projeto descrito continuou pendente')
})

await test('describe sobrevive ao reload do índice', async () => {
  await projectIndex.load()
  assert.equal(projectIndex.byName('nested').description, 'Serviço Java de exemplo')
  assert.equal(projectIndex.byName('nested').role, 'api')
})

await test('projects recusa subcomando desconhecido sem derrubar o servidor', async () => {
  const out = await cli(['projects', 'destruir'], terminalId)
  assert.match(out, /unknown subcommand/)
  assert.match(await cli(['projects', 'list'], terminalId), /index/)
})

await test('describe recusa nome ambíguo em vez de descrever o errado', async () => {
  const a = projectIndex.byName('b')
  const c = projectIndex.byName('nested')
  await projectIndex.patch(a.id, { name: 'backend' })
  await projectIndex.patch(c.id, { name: 'backend' })

  const ambiguo = await cli(['projects', 'describe', 'backend', 'qualquer coisa'], terminalId)
  assert.match(ambiguo, /matches 2 projects/)
  assert.ok(ambiguo.includes(a.path), 'a recusa não mostrou os caminhos para desambiguar')

  // Com o caminho completo, funciona
  const ok = await cli(['projects', 'describe', a.path, 'pelo caminho'], terminalId)
  assert.match(ok, /Updated 'backend'/)
  assert.equal(projectIndex.get(a.id).description, 'pelo caminho')
  assert.notEqual(projectIndex.get(c.id).description, 'pelo caminho', 'descreveu o projeto errado')
})

await test('isPathAllowed barra caminho fora das raízes permitidas', async () => {
  const permitido = { roots: [projectTree] }
  assert.equal(await isPathAllowed('/etc/passwd', permitido), false)
  assert.equal(await isPathAllowed(join(projectTree, 'b'), permitido), true)
  // O separador no prefixo importa: 'proj' não pode liberar 'projeto-x'
  assert.equal(await isPathAllowed(projectTree + '-outro', permitido), false)
  assert.equal(await isPathAllowed('nao/absoluto', permitido), false)
})

await rm(projectTree, { recursive: true, force: true })

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
