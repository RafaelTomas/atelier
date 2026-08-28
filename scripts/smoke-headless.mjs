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
import { mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as esbuild from 'esbuild'

const ROOT = resolve(import.meta.dirname, '..')
const home = await mkdtemp(join(tmpdir(), 'atelier-smoke-'))
process.env.ATELIER_HOME = home
process.env.NODE_ENV = 'development'
// Sem renderer, o wake de portal só tem o caminho de timeout para percorrer —
// e cinco segundos parados não é teste, é espera.
process.env.ATELIER_PORTAL_WAKE_MS = '300'

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
      export { isPathAllowed, resolveAllowedPath, resolveAllowedTarget } from './src/main/core/projects/fs-access.ts'
      export { readTextFile, writeTextFile, renameEntry, duplicateEntry, MAX_TEXT_BYTES } from './src/main/core/projects/file-ops.ts'
      // Função pura do renderer (paths.ts não importa nada): entra aqui porque
      // aspas erradas quebram em silêncio — o comando roda com o argumento errado.
      export { quoteForShell } from './src/renderer/paths.ts'
      export { childEnv, prependPath } from './src/main/core/subprocess-env.ts'
      export { useSafeStorage } from './src/main/core/vault/crypto.ts'
      export { makePortalContent, makeSecretVaultContent } from './src/main/core/models/node-content.ts'
      export { envForTerminal, resolveTemplate, secretForPortal } from './src/main/core/vault/vault-manager.ts'
      export { maskForTerminal } from './src/main/core/vault/masking.ts'
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
const { resolveAllowedPath, resolveAllowedTarget } = core
const { readTextFile, writeTextFile, renameEntry, duplicateEntry, MAX_TEXT_BYTES } = core
const { useSafeStorage, makePortalContent, makeSecretVaultContent } = core
const { envForTerminal, resolveTemplate, secretForPortal, maskForTerminal } = core
const { quoteForShell } = core
const { childEnv, prependPath } = core

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

// ─── Grupos ───────────────────────────────────────────────────────────────────
// As regras que o renderer NÃO pode garantir sozinho: um nó pertence a no
// máximo um grupo, e apagar um nó não pode deixar a moldura contando fantasmas.

let grupoWs
let grupoNo
let grupoA

await test('criar grupo adota só nós que existem, sem repetir', async () => {
  const criado = await appState.createWorkspace('Com Grupos', '')
  const a = makeCanvasNode({ x: 0, y: 0, width: 100, height: 100 }, {
    type: 'text',
    value: { text: 'a', fontSize: 14, fontWeight: 'regular', color: '#000', alignment: 'left', fontFamily: 'sans', isItalic: false, isUnderlined: false, isStrikethrough: false, backgroundColor: null, lineHeight: 1.3, letterSpacing: 0 }
  })
  criado.addNode(a)

  const g = criado.createGroup('Infra', { x: -50, y: -50, width: 400, height: 400 }, [
    a.id,
    a.id,
    'DEADBEEF-0000-0000-0000-000000000000'
  ])
  assert.deepEqual(g.nodeIds, [a.id])
  grupoWs = criado
  grupoNo = a
  grupoA = g
})

await test('entrar num grupo tira do outro — um dono por nó', async () => {
  const b = grupoWs.createGroup('Apps', { x: 500, y: 0, width: 300, height: 300 }, [grupoNo.id])
  assert.deepEqual(b.nodeIds, [grupoNo.id])
  assert.deepEqual(grupoWs.group(grupoA.id).nodeIds, [], 'o nó ficou nos dois grupos')

  // E o caminho de UM nó (o gesto de arrastar) segue a mesma regra.
  grupoWs.setNodeGroup(grupoNo.id, grupoA.id)
  assert.deepEqual(grupoWs.group(grupoA.id).nodeIds, [grupoNo.id])
  assert.deepEqual(grupoWs.group(b.id).nodeIds, [])

  // null solta de todos.
  grupoWs.setNodeGroup(grupoNo.id, null)
  assert.deepEqual(grupoWs.group(grupoA.id).nodeIds, [])
  grupoWs.setNodeGroup(grupoNo.id, grupoA.id)
})

await test('apagar o nó tira o membro, mas a moldura fica', async () => {
  grupoWs.removeNode(grupoNo.id)
  const g = grupoWs.group(grupoA.id)
  assert.ok(g, 'a moldura sumiu junto com o nó')
  assert.deepEqual(g.nodeIds, [], 'o grupo ficou contando um nó que não existe')
})

await test('desagrupar tira a moldura e nada mais', async () => {
  const n = makeCanvasNode({ x: 0, y: 0, width: 10, height: 10 }, {
    type: 'text',
    value: { text: 'b', fontSize: 14, fontWeight: 'regular', color: '#000', alignment: 'left', fontFamily: 'sans', isItalic: false, isUnderlined: false, isStrikethrough: false, backgroundColor: null, lineHeight: 1.3, letterSpacing: 0 }
  })
  grupoWs.addNode(n)
  const g = grupoWs.createGroup('Temp', { x: 0, y: 0, width: 100, height: 100 }, [n.id])
  grupoWs.removeGroup(g.id)
  assert.equal(grupoWs.group(g.id), undefined)
  assert.ok(grupoWs.node(n.id), 'desagrupar apagou o nó')
})

await test('updateFrames move a seleção inteira numa marcação só', async () => {
  const mk = (x) =>
    makeCanvasNode({ x, y: 0, width: 50, height: 50 }, {
      type: 'text',
      value: { text: 'c', fontSize: 14, fontWeight: 'regular', color: '#000', alignment: 'left', fontFamily: 'sans', isItalic: false, isUnderlined: false, isStrikethrough: false, backgroundColor: null, lineHeight: 1.3, letterSpacing: 0 }
    })
  const n1 = mk(0)
  const n2 = mk(100)
  grupoWs.addNode(n1)
  grupoWs.addNode(n2)
  grupoWs.isDirty = false

  grupoWs.updateFrames([
    { nodeId: n1.id, frame: { x: 10, y: 20, width: 50, height: 50 } },
    { nodeId: n2.id, frame: { x: 110, y: 20, width: 50, height: 50 } },
    { nodeId: 'DEADBEEF-0000-0000-0000-000000000000', frame: { x: 0, y: 0, width: 1, height: 1 } }
  ])
  assert.equal(grupoWs.node(n1.id).frame.x, 10)
  assert.equal(grupoWs.node(n2.id).frame.y, 20)
  assert.equal(grupoWs.isDirty, true)

  // Lista vazia não suja o workspace: um arrasto que não moveu nada não é uma
  // alteração, e sujar por isso faria o autosave regravar o arquivo à toa.
  grupoWs.isDirty = false
  grupoWs.updateFrames([])
  assert.equal(grupoWs.isDirty, false)
})

await test('grupos sobrevivem ao round-trip em disco', async () => {
  const g = grupoWs.group(grupoA.id)
  await persistence.saveWorkspace(grupoWs.snapshot(), grupoWs.fileSchemaVersion)
  const reloaded = await persistence.loadWorkspace(grupoWs.id)
  const back = reloaded.groups.find((x) => x.id === g.id)
  assert.ok(back, 'a moldura não voltou do disco')
  assert.equal(back.title, 'Infra')
  assert.deepEqual(back.frame, g.frame)
})

// ─── Reparo de notas que dividiam o mesmo .md ─────────────────────────────────

await test('abrir separa notas gravadas com o mesmo arquivo', async () => {
  const criado = await appState.createWorkspace('Notas Coladas', '')
  const file = paths.workspaceFile(criado.id)

  // Duas notas apontando para Note.md — o que a UI gravava antes da correção
  const nota = (id) => ({
    id,
    frame: [[0, 0], [200, 160]],
    zIndex: 1,
    isLocked: false,
    createdAt: '2026-05-16T00:00:00Z',
    lastModifiedAt: '2026-05-16T00:00:00Z',
    content: {
      stickyNote: {
        _0: {
          color: '#FFF3B0',
          fileName: 'Note.md',
          fontSize: 14,
          hasCustomName: false,
          isPreviewing: false,
          storageMode: { managed: {} },
          fontFamily: 'mono',
          alignment: 'left'
        }
      }
    }
  })
  const doc = JSON.parse(readFileSync(file, 'utf8'))
  doc.payload.nodes = [
    nota('AAAAAAAA-0000-0000-0000-00000000000A'),
    nota('AAAAAAAA-0000-0000-0000-00000000000B')
  ]
  await writeFile(file, JSON.stringify(doc, null, 2))
  await persistence.writeNote(criado.id, 'Note.md', 'o texto que sobrou')

  appState.workspaces.delete(criado.id)
  const reaberto = await appState.openWorkspace(criado.id)
  const arquivos = reaberto.nodes.map((n) => n.content.value.fileName)
  assert.equal(new Set(arquivos).size, 2, 'as duas notas continuam no mesmo arquivo')
  assert.equal(
    await persistence.readNote(criado.id, arquivos[1]),
    'o texto que sobrou',
    'a nota separada nasceu vazia em vez de herdar o texto'
  )

  // O reparo suja o workspace de propósito: grava aqui para o nome novo chegar
  // ao disco (e para não sobrar workspace sujo para o teste seguinte).
  await appState.saveDirtyWorkspaces()
  const gravado = JSON.parse(readFileSync(file, 'utf8'))
  const nomes = gravado.payload.nodes.map((n) => n.content.stickyNote._0.fileName)
  assert.equal(new Set(nomes).size, 2, 'o arquivo voltou a ter as duas notas coladas')
})

// ─── Formato: modo seguro e backup da subida de versão ────────────────────────
// O teste que a perda silenciosa nunca teve. Um workspace com um caso de enum
// que este binário não conhece tem de abrir SEM gravar por cima: o autosave
// regravaria o arquivo sem aquele nó, de forma irreversível e invisível.

await test('nó desconhecido põe o workspace em modo seguro e trava o autosave', async () => {
  const criado = await appState.createWorkspace('Do Futuro', '')
  const file = paths.workspaceFile(criado.id)

  // Escreve à mão um arquivo v3 com um caso que o decoder não conhece —
  // exatamente o que um binário mais VELHO veria ao abrir um workspace novo.
  const doc = JSON.parse(readFileSync(file, 'utf8'))
  doc.payload.nodes = [
    {
      id: 'AAAAAAAA-0000-0000-0000-0000000000FF',
      frame: [[0, 0], [100, 100]],
      zIndex: 1,
      isLocked: false,
      createdAt: '2026-05-16T00:00:00Z',
      lastModifiedAt: '2026-05-16T00:00:00Z',
      content: { hologram: { _0: { algo: 'do futuro' } } }
    }
  ]
  await writeFile(file, JSON.stringify(doc, null, 2))
  const antes = readFileSync(file, 'utf8')

  // Reabre do disco (o manager em memória ainda é o da criação)
  appState.workspaces.delete(criado.id)
  const reaberto = await appState.openWorkspace(criado.id)
  assert.equal(reaberto.droppedNodes, 1, 'o nó descartado não foi contado')
  assert.equal(reaberto.isSafeMode, true)

  // Mexer no canvas suja o workspace, e o autosave PULA
  reaberto.markDirty()
  assert.equal(await appState.saveDirtyWorkspaces(), 0, 'autosave gravou em modo seguro')
  assert.equal(readFileSync(file, 'utf8'), antes, 'o arquivo mudou byte a byte')

  // Só a ação explícita do usuário grava — e aí o aviso perde o objeto
  assert.equal(await appState.saveDirtyWorkspaces(true), 1)
  assert.notEqual(readFileSync(file, 'utf8'), antes)
  assert.equal(reaberto.isSafeMode, false)

  appState.workspaces.delete(criado.id)
})

await test('primeira gravação de um workspace v2 deixa um backup ao lado', async () => {
  const criado = await appState.createWorkspace('Herdado', '')
  const file = paths.workspaceFile(criado.id)
  const backup = join(paths.workspaceDir(criado.id), 'workspace.v2.backup.json')

  // Rebaixa o arquivo para v2, como um workspace gravado antes desta versão
  const doc = JSON.parse(readFileSync(file, 'utf8'))
  doc.schemaVersion = 2
  await writeFile(file, JSON.stringify(doc, null, 2))
  const original = readFileSync(file, 'utf8')

  appState.workspaces.delete(criado.id)
  const reaberto = await appState.openWorkspace(criado.id)
  assert.equal(reaberto.fileSchemaVersion, 2)
  assert.equal(reaberto.isSafeMode, false, 'arquivo mais VELHO não é motivo de modo seguro')

  reaberto.markDirty()
  await appState.saveDirtyWorkspaces()

  assert.ok(existsSync(backup), 'não gravou o backup da v2')
  assert.equal(readFileSync(backup, 'utf8'), original, 'o backup não é o arquivo original')
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).schemaVersion, 7)

  // Segunda gravação não reescreve o backup: o valor dele é ser o ANTES.
  reaberto.markDirty()
  await appState.saveDirtyWorkspaces()
  assert.equal(readFileSync(backup, 'utf8'), original, 'o backup foi sobrescrito')

  appState.workspaces.delete(criado.id)
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
  assert.match(list, /Note/)
})

await test('duas notas nunca dividem o mesmo .md', async () => {
  const a = await cli(['note', 'create', 'texto A'], terminalId)
  const b = await cli(['note', 'create', 'texto B'], terminalId)
  const nameA = a.match(/Created note '([^']+)'/)[1]
  const nameB = b.match(/Created note '([^']+)'/)[1]
  assert.notStrictEqual(nameA, nameB)
  assert.strictEqual((await cli(['note', 'read', nameA], terminalId)).trim(), 'texto A')
  assert.strictEqual((await cli(['note', 'read', nameB], terminalId)).trim(), 'texto B')
})

await test('comando desconhecido não derruba o servidor', async () => {
  const out = await cli(['naoexiste'], terminalId)
  assert.match(out, /unknown command/)
  assert.match(await cli(['debug'], terminalId), /debug/)
})

await test('comando não portado responde de forma honesta', async () => {
  const out = await cli(['recruit', 'x'], terminalId)
  assert.match(out, /ainda não implementado/)
})

// ─── Portais pelo CLI ─────────────────────────────────────────────────────────

let portalId

await test('atelier portal open cria portal já conectado ao chamador', async () => {
  const out = await cli(['portal', 'open', 'localhost:5173', 'Dev'], terminalId)
  assert.match(out, /Opened portal 'Dev'/)
  // A mesma normalização da barra de endereço: sem ela o dev server não abriria
  assert.match(out, /http:\/\/localhost:5173/)

  const criado = ws.nodes.filter((n) => n.content.type === 'portal')
  portalId = criado[criado.length - 1].id
  assert.ok(
    ws.connections.some(
      (c) => (c.nodeIdA === portalId || c.nodeIdB === portalId) && c.kind === 'portal'
    ),
    'o portal nasceu solto, sem cabo para o terminal'
  )

  const list = await cli(['portal', 'list'], terminalId)
  assert.match(list, /Dev/)
})

await test('portal aberto na mesma origem herda a sessão do portal já conectado', async () => {
  // Sem isto, o portal novo nasce com partição própria e o app manda o agente
  // para a tela de login — que foi como este bug apareceu.
  const irmao = await cli(['portal', 'open', 'http://localhost:5173/painel', 'Irmao'], terminalId)
  assert.match(irmao, /session: shared with 'Dev'/)

  const outro = await cli(['portal', 'open', 'https://example.org', 'Estranho'], terminalId)
  assert.match(outro, /session: new/, 'sessão vazando para outra origem')

  await cli(['portal', 'close', 'Irmao'], terminalId)
  await cli(['portal', 'close', 'Estranho'], terminalId)
})

await test('atelier portal go escreve a URL no conteúdo, não no webview', async () => {
  const out = await cli(['portal', 'go', 'Dev', 'example.com'], terminalId)
  assert.match(out, /navigating to https:\/\/example.com/)
  const node = ws.node(portalId)
  assert.equal(node.content.value.currentURL, 'https://example.com')
  // Escrever no conteúdo é o que faz o nó reabrir onde parou, mesmo desmontado
  await appState.saveDirtyWorkspaces()
  const doc = JSON.parse(readFileSync(paths.workspaceFile(ws.id), 'utf8'))
  const gravado = doc.payload.nodes.find((n) => n.id === portalId)
  assert.equal(gravado.content.portal._0.currentURL, 'https://example.com')
})

await test('atelier portal read sem webview montado explica em vez de pendurar', async () => {
  const out = await cli(['portal', 'read', 'Dev'], terminalId)
  assert.match(out, /error: portal .* não respondeu/)
})

// ─── Controle de portal (PLANO-controle-de-portal.md) ────────────────────────

await test('portal click sem permissão é recusado, e o erro diz como ligar', async () => {
  // A trava da Decisão C. O erro é metade do recurso: um agente que só ouve
  // "não pode" tenta outro caminho; um que lê onde fica o botão pede ao usuário.
  const out = await cli(['portal', 'click', 'Dev', '1'], terminalId)
  assert.match(out, /control is off/)
  assert.match(out, /button in that portal header/)
  assert.match(out, /Reading .* works without it/)
})

await test('portal map sem webview montado explica em vez de pendurar', async () => {
  // Ler é livre: `map` não passa pela permissão, só pelo caminho de timeout.
  const out = await cli(['portal', 'map', 'Dev'], terminalId)
  assert.match(out, /error: portal .* não respondeu/)
})

await test('ref sem mapa válido pede um mapa novo, não acorda o portal', async () => {
  // Com a permissão ligada, uma ref de mapa velho (ou inexistente) tem de
  // devolver "rode map" — nunca "o portal não respondeu", e nunca um clique
  // num elemento que calhou de ter o mesmo número.
  ws.updateContent(portalId, (node) => {
    node.content.value.controlEnabled = true
  })
  const out = await cli(['portal', 'click', 'Dev', '3'], terminalId)
  assert.match(out, /nenhum mapa válido/)
  assert.match(out, /portal map/)
  ws.updateContent(portalId, (node) => {
    node.content.value.controlEnabled = false
  })
})

await test('portal não conectado ao terminal não é alcançável nem para clicar', async () => {
  // O escopo por cabo não ganha exceção nova por causa dos verbos de escrita.
  const out = await cli(['portal', 'click', 'Inexistente', '1'], terminalId)
  assert.match(out, /not found/)
})

await test('atelier portal close leva o cabo junto', async () => {
  const out = await cli(['portal', 'close', 'Dev'], terminalId)
  assert.match(out, /Closed portal 'Dev'/)
  assert.equal(ws.node(portalId), undefined)
  assert.ok(
    !ws.connections.some((c) => c.nodeIdA === portalId || c.nodeIdB === portalId),
    'a conexão sobreviveu ao nó'
  )
})

// ─── Cofre: CLI, ambiente do PTY e login de portal ───────────────────────────
// O cofre inteiro depende de uma cripto do SO que não existe num teste headless,
// então o `safeStorage` é INJETADO — é para isso que `crypto.ts` recebe a
// implementação em vez de importá-la. O mock não cifra nada de verdade (base64
// com um prefixo); o que está sob teste aqui não é a cifra do Electron, é o
// caminho: quem pode ler o quê, o que entra no ambiente, e o que o Atelier
// recusa a digitar numa página.

const fakeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (text) => Buffer.from(`mock:${text}`, 'utf8'),
  decryptString: (buf) => buf.toString('utf8').replace(/^mock:/, '')
}

let vaultNodeId
let vaultPortalId

await test('monta cofre, terminal e portal ligados por cabo', async () => {
  useSafeStorage(fakeStorage)

  const vault = makeCanvasNode(
    { x: 11200, y: 8600, width: 320, height: 280 },
    { type: 'secretVault', value: makeSecretVaultContent('Pessoal') }
  )
  const portal = makeCanvasNode(
    { x: 11600, y: 8600, width: 640, height: 440 },
    { type: 'portal', value: makePortalContent('Conta', 'https://github.com/login') }
  )
  ws.addNode(vault)
  ws.addNode(portal)
  vaultNodeId = vault.id
  vaultPortalId = portal.id

  assert.equal(ws.addConnection(terminalId, vault.id)?.kind, 'secret')
  assert.equal(ws.addConnection(portal.id, vault.id)?.kind, 'secret')
  assert.ok(ws.addConnection(terminalId, portal.id), 'terminal ↔ portal')

  // As entradas vão direto ao arquivo, como se a UI as tivesse gravado: o CLI
  // não escreve segredo, e é justamente isso que este teste NÃO pode contornar.
  const content = ws.node(vault.id).content.value
  await persistence.writeVault(ws.id, content.id, {
    version: 1,
    kdf: null,
    entries: [
      { key: 'DB_URL', value: 'postgres://u:senha@host/db', origin: null, inEnv: true, note: null, updatedAt: '' },
      { key: 'GITHUB_PASS', value: 'hunter2-github', origin: 'https://github.com', inEnv: false, note: null, updatedAt: '' },
      { key: 'SEM_ORIGEM', value: 'valor-sem-origem', origin: null, inEnv: false, note: null, updatedAt: '' }
    ]
  })
  ws.updateContent(vault.id, (node) => {
    node.content.value.keys = [
      { key: 'DB_URL', inEnv: true, origin: null, note: null },
      { key: 'GITHUB_PASS', inEnv: false, origin: 'https://github.com', note: null },
      { key: 'SEM_ORIGEM', inEnv: false, origin: null, note: null }
    ]
  })
})

await test('atelier vault list mostra chaves e flags, nunca valores', async () => {
  const out = await cli(['vault', 'list'], terminalId)
  assert.match(out, /Pessoal/)
  assert.match(out, /DB_URL/)
  assert.match(out, /origin https:\/\/github\.com/)
  assert.doesNotMatch(out, /hunter2/, 'list vazou um valor')
  assert.doesNotMatch(out, /senha@host/, 'list vazou um valor')
})

await test('atelier vault get entrega o valor e avisa que ele está no contexto', async () => {
  const out = await cli(['vault', 'get', 'Pessoal', 'GITHUB_PASS'], terminalId)
  assert.match(out, /hunter2-github/)
  assert.match(out, /now in your context/)
})

await test('o valor lido passa a ser mascarado no scrollback daquele terminal', () => {
  // O `get` acima registrou o valor. O que o PTY gravar a partir de agora sai
  // com a máscara — é o que impede o segredo de ficar em claro no arquivo.
  const masked = maskForTerminal(terminalId, 'echo hunter2-github > /tmp/x')
  assert.doesNotMatch(masked, /hunter2-github/)
  assert.match(masked, /echo .* > \/tmp\/x/)
})

await test('outro terminal não herda o mascaramento nem o acesso', async () => {
  const outro = makeCanvasNode(
    { x: 0, y: 0, width: 100, height: 100 },
    { type: 'terminal', value: makeTerminalContent('Sem cabo') }
  )
  ws.addNode(outro)
  assert.match(maskForTerminal(outro.id, 'hunter2-github'), /hunter2-github/)
  const out = await cli(['vault', 'get', 'Pessoal', 'GITHUB_PASS'], outro.id)
  assert.match(out, /not found/, 'cofre sem cabo não pode ser lido')
})

await test('atelier vault get recusa chave que não existe, e diz quais existem', async () => {
  const out = await cli(['vault', 'get', 'Pessoal', 'NAO_EXISTE'], terminalId)
  assert.match(out, /error: key 'NAO_EXISTE' not found/)
  assert.match(out, /DB_URL/)
})

await test('só as chaves marcadas "no ambiente" entram no PTY', async () => {
  const { env, keys, error } = await envForTerminal(terminalId)
  assert.equal(error, undefined)
  assert.deepEqual(keys, ['DB_URL'])
  assert.equal(env.DB_URL, 'postgres://u:senha@host/db')
  assert.equal(env.GITHUB_PASS, undefined, 'chave sem inEnv não pode vazar para o ambiente')
})

await test('colisão de chave entre dois cofres RECUSA o spawn, não escolhe um', async () => {
  const outro = makeCanvasNode(
    { x: 11200, y: 9000, width: 320, height: 280 },
    { type: 'secretVault', value: makeSecretVaultContent('Trabalho') }
  )
  ws.addNode(outro)
  ws.addConnection(terminalId, outro.id)
  await persistence.writeVault(ws.id, outro.content.value.id, {
    version: 1,
    kdf: null,
    entries: [
      { key: 'DB_URL', value: 'postgres://outro', origin: null, inEnv: true, note: null, updatedAt: '' }
    ]
  })

  const { error } = await envForTerminal(terminalId)
  assert.match(error ?? '', /DB_URL/)
  assert.match(error ?? '', /Pessoal/)
  assert.match(error ?? '', /Trabalho/)

  ws.removeNode(outro.id)
})

await test('${vault:...} é expandido no comando, e some quando o cabo não existe', async () => {
  const ok = await resolveTemplate(terminalId, 'psql "${vault:Pessoal/DB_URL}"')
  assert.equal(ok.command, 'psql "postgres://u:senha@host/db"')

  const semCofre = await resolveTemplate(terminalId, 'psql "${vault:Inexistente/DB_URL}"')
  assert.match(semCofre.error ?? '', /não é um cofre ligado/)

  const semChave = await resolveTemplate(terminalId, 'psql "${vault:Pessoal/NADA}"')
  assert.match(semChave.error ?? '', /não tem a chave/)
})

await test('portal login: chave sem origem declarada é recusada em qualquer página', async () => {
  const out = await secretForPortal(terminalId, vaultPortalId, 'Pessoal', 'SEM_ORIGEM', 'https://github.com/login')
  assert.equal(typeof out, 'string')
  assert.match(out, /declares no origin/)
})

await test('portal login: origem diferente da página é recusada, nomeando as duas', async () => {
  const out = await secretForPortal(terminalId, vaultPortalId, 'Pessoal', 'GITHUB_PASS', 'https://phishing.example/login')
  assert.equal(typeof out, 'string')
  assert.match(out, /only allowed on https:\/\/github\.com/)
  assert.match(out, /phishing\.example/)
  assert.match(out, /Nothing was typed/)
})

await test('portal login: http não passa por https — o downgrade é o ataque', async () => {
  const out = await secretForPortal(terminalId, vaultPortalId, 'Pessoal', 'GITHUB_PASS', 'http://github.com/login')
  assert.equal(typeof out, 'string')
  assert.match(out, /only allowed on/)
})

await test('portal login: origem batendo entrega o valor para o main digitar', async () => {
  const out = await secretForPortal(terminalId, vaultPortalId, 'Pessoal', 'GITHUB_PASS', 'https://github.com/session')
  assert.equal(typeof out, 'object', out.toString?.())
  assert.equal(out.value, 'hunter2-github')
  assert.equal(out.vault.label, 'Pessoal')
})

await test('portal login: cofre ligado ao terminal mas NÃO ao portal é recusado', async () => {
  const solto = makeCanvasNode(
    { x: 12200, y: 9000, width: 640, height: 440 },
    { type: 'portal', value: makePortalContent('Outro', 'https://github.com/login') }
  )
  ws.addNode(solto)
  ws.addConnection(terminalId, solto.id)
  const out = await secretForPortal(terminalId, solto.id, 'Pessoal', 'GITHUB_PASS', 'https://github.com/login')
  assert.equal(typeof out, 'string')
  assert.match(out, /not connected to that portal/)
  ws.removeNode(solto.id)
})

await test('a trilha de auditoria registra os acessos e nenhum valor', async () => {
  const linhas = await persistence.readVaultAccess(ws.id, 50)
  assert.ok(linhas.length >= 2, 'nada foi auditado')
  const texto = linhas.join('\n')
  assert.match(texto, /get GITHUB_PASS/)
  assert.match(texto, /login GITHUB_PASS/)
  assert.doesNotMatch(texto, /hunter2/, 'a trilha gravou o segredo')
})

await test('atelier list anuncia o cofre pelo nome e pela contagem, sem as chaves', async () => {
  const out = await cli(['list'], terminalId)
  assert.match(out, /Connected vaults:/)
  assert.match(out, /Pessoal {2}3 keys/)
  assert.doesNotMatch(out, /GITHUB_PASS/, 'list expôs nome de chave')
  assert.doesNotMatch(out, /hunter2/, 'list expôs um valor')
})

await test('cofre ilegível (sem chaveiro) é recusado inteiro, e o CLI explica', async () => {
  useSafeStorage({ ...fakeStorage, isEncryptionAvailable: () => false })
  const out = await cli(['vault', 'get', 'Pessoal', 'GITHUB_PASS'], terminalId)
  assert.match(out, /locked/)
  assert.match(out, /keychain/)
  useSafeStorage(fakeStorage)
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

// ─── Operações de arquivo ─────────────────────────────────────────────────────
// Onde as regras do editor valem alguma coisa: teto de tamanho, recusa de
// binário e a promessa de nunca sobrescrever um destino que já existe.

const fileLab = join(projectTree, 'lab')
await mkdir(fileLab, { recursive: true })

await test('readTextFile lê texto e recusa arquivo acima do teto', async () => {
  const small = join(fileLab, 'nota.txt')
  await writeFile(small, 'oi\nmundo\n')
  const ok = await readTextFile(small)
  assert.equal(ok.text, 'oi\nmundo\n')
  assert.equal(ok.bytes, 9)

  // Um byte acima do teto: leitura parcial seria pior que a recusa — salvar
  // depois truncaria o arquivo do usuário.
  const big = join(fileLab, 'grande.log')
  await writeFile(big, Buffer.alloc(MAX_TEXT_BYTES + 1, 0x61))
  assert.equal((await readTextFile(big)).error, 'too-large')
})

await test('readTextFile recusa binário pelo byte nulo do começo', async () => {
  const bin = join(fileLab, 'programa.bin')
  await writeFile(bin, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x01, 0x02]))
  assert.equal((await readTextFile(bin)).error, 'binary')

  // Arquivo inexistente e diretório não viram exceção: viram motivo.
  assert.equal((await readTextFile(join(fileLab, 'nao-existe'))).error, 'missing')
  assert.equal((await readTextFile(fileLab)).error, 'not-a-file')
})

await test('writeTextFile grava de forma atômica e não deixa .tmp para trás', async () => {
  const file = join(fileLab, 'nota.txt')
  assert.deepEqual(await writeTextFile(file, 'novo conteúdo'), { ok: true })
  assert.equal((await readTextFile(file)).text, 'novo conteúdo')
  const sujeira = (await readdir(fileLab)).filter((f) => f.includes('atelier-tmp'))
  assert.deepEqual(sujeira, [], 'sobrou arquivo temporário')
})

await test('renameEntry recusa destino existente em vez de sobrescrever', async () => {
  const a = join(fileLab, 'a.txt')
  const b = join(fileLab, 'b.txt')
  await writeFile(a, 'A')
  await writeFile(b, 'B')

  assert.equal((await renameEntry(a, b)).error, 'exists')
  assert.equal((await readTextFile(b)).text, 'B', 'o destino foi sobrescrito')

  const c = join(fileLab, 'c.txt')
  assert.equal((await renameEntry(a, c)).path, c)
  assert.equal((await readTextFile(c)).text, 'A')
})

await test('duplicateEntry acha o primeiro nome livre, com a extensão no fim', async () => {
  const src = join(fileLab, 'app.ts')
  await writeFile(src, 'export {}')

  const first = await duplicateEntry(src)
  assert.equal(first.path, join(fileLab, 'app copy.ts'))
  assert.equal((await readTextFile(first.path)).text, 'export {}')

  // Segunda cópia não colide com a primeira
  const second = await duplicateEntry(src)
  assert.equal(second.path, join(fileLab, 'app copy 2.ts'))

  // Nome sem extensão de verdade continua inteiro
  const dot = join(fileLab, '.gitignore')
  await writeFile(dot, 'node_modules')
  assert.equal((await duplicateEntry(dot)).path, join(fileLab, '.gitignore copy'))
})

await test('resolveAllowedTarget valida destino que ainda não existe pelo pai', async () => {
  const permitido = { roots: [projectTree] }
  const dentro = await resolveAllowedTarget(join(fileLab, 'ainda-nao.txt'), permitido)
  assert.equal(dentro.ok, true)
  assert.equal(dentro.root, await realpath(projectTree))

  // O caminho relativo escapando pelo pai é resolvido ANTES de comparar
  const fuga = await resolveAllowedTarget(join(fileLab, '..', '..', '..', 'passwd'), permitido)
  assert.equal(fuga.ok, false)
  // Pai inexistente é 'missing', não uma criação de diretório silenciosa
  const orfao = await resolveAllowedTarget(join(fileLab, 'nao', 'existe.txt'), permitido)
  assert.deepEqual(orfao, { ok: false, reason: 'missing' })
})

await test('resolveAllowedPath diz sob QUAL raiz o caminho caiu', async () => {
  // É o que permite exigir origem e destino na mesma raiz ao mover.
  const duasRaizes = { roots: [join(projectTree, 'b'), join(projectTree, 'c')] }
  const a = await resolveAllowedPath(join(projectTree, 'b'), duasRaizes)
  const b = await resolveAllowedPath(join(projectTree, 'c'), duasRaizes)
  assert.equal(a.ok && b.ok, true)
  assert.notEqual(a.root, b.root)
})

await test('quoteForShell só põe aspas quando o caminho precisa', () => {
  // O caso comum sai limpo: aspas em todo caminho seriam ruído na linha.
  assert.equal(quoteForShell('/home/u/src/app.ts', 'linux'), '/home/u/src/app.ts')

  // Espaço sem aspas vira DOIS argumentos — é o erro que este teste existe para pegar.
  assert.equal(quoteForShell('/home/u/My Docs/a.ts', 'linux'), "'/home/u/My Docs/a.ts'")
  assert.equal(quoteForShell('/home/u/a$b.ts', 'darwin'), "'/home/u/a$b.ts'")

  // Aspa simples no nome: fecha, escapa, reabre.
  assert.equal(quoteForShell("/home/u/it's.ts", 'linux'), "'/home/u/it'\\''s.ts'")

  // No Windows são aspas duplas: o cmd.exe não entende as simples.
  assert.equal(quoteForShell('C:\\Users\\u\\My Docs\\a.ts', 'win32'), '"C:\\Users\\u\\My Docs\\a.ts"')
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

await test('childEnv normaliza a chave do PATH e nunca deixa duas', () => {
  const original = { ...process.env }
  try {
    // Simula o Windows: a variável chega como `Path`, não `PATH`.
    for (const k of Object.keys(process.env)) {
      if (k.toLowerCase() === 'path') delete process.env[k]
    }
    process.env.Path = '/usr/bin:/bin'

    const env = childEnv({ FOO: 'bar' })
    const pathKeys = Object.keys(env).filter((k) => k.toLowerCase() === 'path')
    assert.deepEqual(pathKeys, ['PATH'], 'uma única chave, e é PATH')
    assert.equal(env.PATH, '/usr/bin:/bin')
    assert.equal(env.FOO, 'bar')

    prependPath(env, '/opt/atelier/bin')
    const sep = process.platform === 'win32' ? ';' : ':'
    assert.equal(env.PATH, `/opt/atelier/bin${sep}/usr/bin:/bin`)
    assert.deepEqual(
      Object.keys(env).filter((k) => k.toLowerCase() === 'path'),
      ['PATH']
    )
  } finally {
    for (const k of Object.keys(process.env)) {
      if (k.toLowerCase() === 'path') delete process.env[k]
    }
    Object.assign(process.env, original)
  }
})

// ─── Exclusão de workspace ───────────────────────────────────────────────────
// A ação é `rm -rf` no diretório inteiro, sem lixeira e sem desfazer. O que os
// testes protegem é o que não dá para ver na tela: que o diretório some mesmo, e
// que o autosave não o recria depois.

await test('excluir um workspace apaga o diretório inteiro', async () => {
  const criado = await appState.createWorkspace('Descartável', '')
  const dir = paths.workspaceDir(criado.id)
  assert.ok(existsSync(dir))

  await appState.deleteWorkspace(criado.id)

  assert.equal(existsSync(dir), false, 'o diretório sobreviveu ao rm')
  assert.equal(
    appState.manifest.workspaces.some((w) => w.id === criado.id),
    false,
    'o workspace continua no manifesto'
  )
  // O manifesto EM DISCO também, não só o da memória: um crash logo depois não
  // pode ressuscitar a entrada de um workspace cujos arquivos já sumiram.
  const manifesto = await persistence.loadManifest()
  assert.equal(manifesto.workspaces.some((w) => w.id === criado.id), false)
})

await test('autosave em voo não recria o diretório do workspace excluído', async () => {
  const criado = await appState.createWorkspace('Some no Meio', '')
  const dir = paths.workspaceDir(criado.id)
  criado.markDirty()

  // A corrida de verdade: `saveDirtyWorkspaces` tira o retrato de todos os
  // sujos de uma vez e grava um a um, com await entre eles. A exclusão parte no
  // MESMO tick, depois do retrato e antes das gravações.
  const gravando = appState.saveDirtyWorkspaces()
  await appState.deleteWorkspace(criado.id)
  await gravando

  assert.equal(existsSync(dir), false, 'o autosave recriou o diretório excluído')
})

// Por último de propósito: este teste esvazia o app, e tudo o que vem antes
// depende de haver workspace aberto.
await test('excluir o último workspace é permitido e leva ao estado vazio', async () => {
  const antes = appState.manifest.workspaces.map((w) => w.id)
  for (const id of antes) await appState.deleteWorkspace(id)
  assert.equal(appState.manifest.workspaces.length, 0)
  assert.equal(appState.data.activeWorkspaceId, null, 'ficou apontando para um id que não existe')
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
