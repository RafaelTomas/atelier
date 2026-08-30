/**
 * Teste de compatibilidade do formato — a checagem mais importante deste porte.
 *
 * Valida que o codec TypeScript lê o formato Maestri e o escreve de volta SEM
 * PERDA, incluindo os tipos de nó que a UI ainda não renderiza. É o que garante
 * que abrir um workspace do app Swift aqui e voltar para lá não destrói dados.
 *
 * As três regras verificadas empiricamente contra swiftc (JSONEncoder .iso8601):
 *   UUID maiúsculo · Date sem milissegundos · CGPoint [x,y] / CGRect [[x,y],[w,h]]
 *
 * Uso: node scripts/test-codec.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as esbuild from 'esbuild'

const ROOT = resolve(import.meta.dirname, '..')

// Compila o codec (TS) para um bundle temporário — sem depender do build do app
async function loadCodec() {
  const outdir = await mkdtemp(join(tmpdir(), 'atelier-codec-'))
  const outfile = join(outdir, 'codec.mjs')
  await esbuild.build({
    // Bundle por stdin, e não por entryPoint único, porque o par de tipos que
    // vira `kind` mora em shared/types.ts: testar a dedução pelo documento
    // gravado provaria só o codec, e a regra que decide o cabo ficaria de fora.
    stdin: {
      contents: `
        export * from './src/main/core/models/workspace.ts'
        export { connectionKindForTypes } from './src/shared/types.ts'
        // As preferências entram aqui porque a posição das pílulas é gravada num
        // arquivo COMPARTILHADO com o app nativo Swift, que não conhece as
        // chaves novas e as apaga no save dele. O que este teste protege é que
        // essa perda devolva o padrão em vez de esconder a dock.
        export { decodePreferences, makePreferences } from './src/main/core/models/app-state.ts'
      `,
      resolveDir: ROOT,
      loader: 'ts'
    },
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile,
    logLevel: 'silent',
    alias: { '@shared': join(ROOT, 'src/shared') }
  })
  const mod = await import(pathToFileURL(outfile).href)
  return { mod, cleanup: () => rm(outdir, { recursive: true, force: true }) }
}

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

const { mod, cleanup } = await loadCodec()
const { decodeWorkspaceDocument, encodeWorkspaceDocument, connectionKindForTypes } = mod
const { decodePreferences, makePreferences } = mod

const raw = JSON.parse(readFileSync(join(ROOT, 'fixtures/full-workspace.json'), 'utf8'))
const { payload } = decodeWorkspaceDocument(raw)
const reencoded = encodeWorkspaceDocument(payload)

console.log('\ncodec de compatibilidade Maestri\n')

test('decodifica os 9 tipos de nó', () => {
  const types = payload.nodes.map((n) => n.content.type).sort()
  assert.deepEqual(types, [
    'codeEditor',
    'fileTree',
    'freehand',
    'portal',
    'shape',
    'stickyNote',
    'stroke',
    'terminal',
    'text'
  ])
})

test('codeEditor guarda o caminho e MAIS NADA', () => {
  // Campo extra em conteúdo de nó é descartado na releitura (aqui e no app
  // nativo): o que se deriva do disco não pode morar no workspace.json.
  const editor = reencoded.payload.nodes.find((n) => n.content.codeEditor).content.codeEditor._0
  assert.deepEqual(editor, { filePath: '/tmp/test/src/main.ts' })
})

test('frame decodifica de [[x,y],[w,h]]', () => {
  const node = payload.nodes.find((n) => n.content.type === 'terminal')
  assert.deepEqual(node.frame, { x: 9900, y: 8600, width: 560, height: 360 })
})

test('frame re-encoda como [[x,y],[w,h]], não como objeto', () => {
  const node = reencoded.payload.nodes.find((n) => n.content.terminal)
  assert.deepEqual(node.frame, [[9900, 8600], [560, 360]])
})

test('canvasOrigin re-encoda como [x,y] (CGPoint do Swift é array)', () => {
  assert.deepEqual(reencoded.payload.canvasOrigin, [9800, 8500])
})

test('NodeContent mantém o embrulho { tipo: { _0: … } }', () => {
  for (const node of reencoded.payload.nodes) {
    const keys = Object.keys(node.content)
    assert.equal(keys.length, 1, 'conteúdo deve ter exatamente uma chave de variante')
    assert.ok('_0' in node.content[keys[0]], `variante ${keys[0]} sem _0`)
  }
})

test('StorageMode.managed encoda como objeto vazio', () => {
  const note = reencoded.payload.nodes.find((n) => n.content.stickyNote)
  assert.deepEqual(note.content.stickyNote._0.storageMode, { managed: {} })
})

test('PortalSource.url mantém o embrulho _0', () => {
  const portal = reencoded.payload.nodes.find((n) => n.content.portal)
  assert.deepEqual(portal.content.portal._0.source, { url: { _0: 'https://example.com' } })
})

/**
 * A partição herdada é o que mantém um popup LOGADO: o nó filho nasce com id
 * novo, logo partição nova, logo sessão vazia — a menos que o storageScope
 * carregue a partição do pai. Se o codec descartar esse valor, o popup volta a
 * nascer na tela de login. Ver Decisão B do plano do Portal.
 */
test('storageScope com partição herdada sobrevive à ida e volta', () => {
  const clone = structuredClone(raw)
  const portalNode = clone.payload.nodes.find((n) => n.content.portal)
  portalNode.content.portal._0.storageScope = 'persist:portal-ABC'

  const { payload: p } = decodeWorkspaceDocument(clone)
  const decoded = p.nodes.find((n) => n.content.type === 'portal')
  assert.equal(decoded.content.value.storageScope, 'persist:portal-ABC')

  const back = encodeWorkspaceDocument(p)
  const encoded = back.payload.nodes.find((n) => n.content.portal)
  assert.equal(encoded.content.portal._0.storageScope, 'persist:portal-ABC')
})

/**
 * A permissão de controle NUNCA volta ligada por omissão de dado.
 *
 * Um portal gravado antes do campo existir — ou pelo app nativo, que não o
 * conhece — tem de carregar com `false`: a alternativa é um portal dirigível
 * pelo agente sem que ninguém tenha clicado em nada. Ver Decisão C do
 * 2026-08-27-PLANO-controle-de-portal.md.
 */
test('controlEnabled sobrevive à ida e volta, e ausente vira false', () => {
  const clone = structuredClone(raw)
  const portalNode = clone.payload.nodes.find((n) => n.content.portal)
  assert.ok(
    !('controlEnabled' in portalNode.content.portal._0),
    'o fixture já traz o campo — o caso do documento antigo deixou de ser testado'
  )

  const { payload: velho } = decodeWorkspaceDocument(clone)
  const semCampo = velho.nodes.find((n) => n.content.type === 'portal')
  assert.equal(semCampo.content.value.controlEnabled, false)

  portalNode.content.portal._0.controlEnabled = true
  const { payload: p } = decodeWorkspaceDocument(clone)
  const decoded = p.nodes.find((n) => n.content.type === 'portal')
  assert.equal(decoded.content.value.controlEnabled, true)

  const back = encodeWorkspaceDocument(p)
  const encoded = back.payload.nodes.find((n) => n.content.portal)
  assert.equal(encoded.content.portal._0.controlEnabled, true)
})

test('CGPoint dentro de stroke re-encoda como array', () => {
  const stroke = reencoded.payload.nodes.find((n) => n.content.stroke)
  assert.deepEqual(stroke.content.stroke._0.startPoint, [0, 0.5])
  assert.deepEqual(stroke.content.stroke._0.controlPoint, [0.5, 0.5])
})

test('as 6 listas de conexão são reconstruídas com seus nomes de campo', () => {
  assert.equal(reencoded.payload.connections.length, 1)
  assert.ok('terminalIdA' in reencoded.payload.connections[0])
  assert.equal(reencoded.payload.noteConnections.length, 1)
  assert.ok('noteNodeId' in reencoded.payload.noteConnections[0])
  assert.equal(reencoded.payload.portalConnections.length, 1)
  assert.ok('portalNodeId' in reencoded.payload.portalConnections[0])
  for (const key of ['portalToPortalConnections', 'noteToNoteConnections', 'crossFloorConnections']) {
    assert.ok(Array.isArray(reencoded.payload[key]), `${key} deve existir mesmo vazio`)
  }
})

test('nó legado de texto ganha defaults de formatação sem perder o que já tinha', () => {
  // A fixture não tem os campos novos (isItalic, backgroundColor, …): é
  // exatamente um arquivo escrito pelo app nativo antes da barra de formatação.
  const text = payload.nodes.find((n) => n.content.type === 'text').content.value
  assert.equal(text.text, 'Sprint 12')
  assert.equal(text.fontWeight, 'bold')
  assert.equal(text.isItalic, false)
  assert.equal(text.isUnderlined, false)
  assert.equal(text.isStrikethrough, false)
  assert.equal(text.backgroundColor, null)
  assert.equal(text.lineHeight, 1.3)
  assert.equal(text.letterSpacing, 0)
})

test('nota legada tem fonte mono e cor de texto automática', () => {
  // 'mono' e textColor null reproduzem a aparência anterior da nota, quando o
  // editor era mono e a cor vinha fixa do CSS.
  const note = payload.nodes.find((n) => n.content.type === 'stickyNote').content.value
  assert.equal(note.fontFamily, 'mono')
  assert.equal(note.textColor, null)
  assert.equal(note.alignment, 'left')
})

test('campos de formatação sobrevivem ao round-trip', () => {
  const encoded = reencoded.payload.nodes.find((n) => n.content.text).content.text._0
  const back = decodeWorkspaceDocument({
    ...raw,
    payload: {
      ...raw.payload,
      nodes: [
        {
          ...raw.payload.nodes.find((n) => n.content.text),
          content: {
            text: {
              _0: {
                ...encoded,
                isItalic: true,
                isUnderlined: true,
                isStrikethrough: true,
                backgroundColor: '#E6F0FF',
                lineHeight: 1.8,
                letterSpacing: 2,
                fontFamily: 'serif',
                fontWeight: 'semibold',
                alignment: 'center'
              }
            }
          }
        }
      ]
    }
  })
  const value = back.payload.nodes[0].content.value
  assert.equal(value.isItalic, true)
  assert.equal(value.isUnderlined, true)
  assert.equal(value.isStrikethrough, true)
  assert.equal(value.backgroundColor, '#E6F0FF')
  assert.equal(value.lineHeight, 1.8)
  assert.equal(value.letterSpacing, 2)
  assert.equal(value.fontFamily, 'serif')
  assert.equal(value.fontWeight, 'semibold')
  assert.equal(value.alignment, 'center')

  // E voltam ao disco dentro do embrulho da variante, sem virar objeto solto.
  const out = encodeWorkspaceDocument(back.payload).payload.nodes[0].content.text._0
  assert.equal(out.isItalic, true)
  assert.equal(out.backgroundColor, '#E6F0FF')
  assert.equal(out.fontFamily, 'serif')
})

test('valor inválido de enum tipográfico cai no default em vez de ir para o CSS', () => {
  const node = raw.payload.nodes.find((n) => n.content.text)
  const back = decodeWorkspaceDocument({
    ...raw,
    payload: {
      ...raw.payload,
      nodes: [
        {
          ...node,
          content: {
            text: {
              _0: {
                ...node.content.text._0,
                fontFamily: 'comic-sans-do-mal',
                fontWeight: 'ultra',
                alignment: 'justify'
              }
            }
          }
        }
      ]
    }
  })
  const value = back.payload.nodes[0].content.value
  assert.equal(value.fontFamily, 'sans')
  assert.equal(value.fontWeight, 'regular')
  assert.equal(value.alignment, 'left')
})

test('UUIDs saem em maiúsculas', () => {
  for (const node of reencoded.payload.nodes) {
    assert.equal(node.id, node.id.toUpperCase(), `${node.id} não está em maiúsculas`)
  }
})

test('datas ficam em ISO8601 sem milissegundos', () => {
  const re = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/
  for (const node of reencoded.payload.nodes) {
    assert.match(node.createdAt, re)
    assert.match(node.lastModifiedAt, re)
  }
})

test('round-trip é estável (encode∘decode∘encode == encode)', () => {
  const second = encodeWorkspaceDocument(decodeWorkspaceDocument(reencoded).payload)
  assert.deepEqual(second, reencoded)
})

test('nó de variante desconhecida é contado, não perdido em silêncio', () => {
  // O caso que a contagem existe para pegar: um workspace gravado por uma
  // versão mais nova. Sem ela, o nó sumiria e o primeiro autosave regravaria o
  // arquivo sem ele — perda invisível. Com ela, o app abre em modo seguro.
  const doc = decodeWorkspaceDocument({
    ...raw,
    payload: {
      ...raw.payload,
      nodes: [
        ...raw.payload.nodes,
        {
          id: 'AAAAAAAA-0000-0000-0000-0000000000FF',
          frame: [[0, 0], [100, 100]],
          zIndex: 99,
          isLocked: false,
          createdAt: '2026-05-16T00:00:00Z',
          lastModifiedAt: '2026-05-16T00:00:00Z',
          content: { hologram: { _0: { algo: 'do futuro' } } }
        }
      ]
    }
  })
  assert.equal(doc.droppedNodes, 1)
  assert.equal(doc.payload.nodes.length, raw.payload.nodes.length)
  // E o arquivo íntegro não acusa nada.
  assert.equal(decodeWorkspaceDocument(raw).droppedNodes, 0)
})

test('nós não implementados na UI sobrevivem ao round-trip', () => {
  const survivors = ['shape', 'stroke', 'freehand', 'fileTree']
  for (const type of survivors) {
    assert.ok(
      reencoded.payload.nodes.some((n) => type in n.content),
      `nó ${type} foi perdido`
    )
  }
})

test('nó dataTable faz round-trip no formato Maestri { dataTable: { _0: … } }', () => {
  const doc = decodeWorkspaceDocument({
    ...raw,
    payload: {
      ...raw.payload,
      nodes: [
        {
          id: 'BBBBBBBB-0000-0000-0000-0000000000AA',
          frame: [[100, 200], [520, 360]],
          zIndex: 5,
          isLocked: false,
          createdAt: '2026-08-26T00:00:00Z',
          lastModifiedAt: '2026-08-26T00:00:00Z',
          content: {
            dataTable: {
              _0: {
                id: 'bbbbbbbb-0000-0000-0000-0000000000bb',
                title: 'Usuários ativos',
                fileName: 'BBBBBBBB-0000-0000-0000-0000000000BB.json',
                query: 'SELECT * FROM users',
                dialect: 'postgres',
                rowCount: 143,
                columnCount: 5,
                truncated: true,
                executedAt: '2026-08-26T12:00:00Z'
              }
            }
          }
        }
      ]
    }
  })
  assert.equal(doc.droppedNodes, 0)
  const value = doc.payload.nodes[0].content.value
  assert.equal(value.title, 'Usuários ativos')
  assert.equal(value.query, 'SELECT * FROM users')
  assert.equal(value.dialect, 'postgres')
  assert.equal(value.rowCount, 143)
  assert.equal(value.truncated, true)
  assert.equal(value.id, value.id.toUpperCase(), 'id da tabela normalizado para maiúsculas')

  const out = encodeWorkspaceDocument(doc.payload).payload.nodes[0].content
  assert.ok(out.dataTable && '_0' in out.dataTable, 'perdeu o embrulho da variante')
  assert.equal(out.dataTable._0.title, 'Usuários ativos')
  assert.match(out.dataTable._0.executedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
})

test('conexão terminal↔dataTable vira kind "data" e volta para dataConnections', () => {
  const doc = decodeWorkspaceDocument({
    ...raw,
    payload: {
      ...raw.payload,
      dataConnections: [
        {
          id: 'CCCCCCCC-0000-0000-0000-0000000000AA',
          terminalId: 'DDDDDDDD-0000-0000-0000-0000000000AA',
          dataNodeId: 'EEEEEEEE-0000-0000-0000-0000000000AA',
          createdAt: '2026-08-26T00:00:00Z',
          ropePoints: []
        }
      ]
    }
  })
  const conn = doc.payload.connections.find((c) => c.kind === 'data')
  assert.ok(conn, 'conexão data não foi decodificada')
  const back = encodeWorkspaceDocument(doc.payload)
  assert.equal(back.payload.dataConnections.length, 1)
  assert.ok('dataNodeId' in back.payload.dataConnections[0])
})

test('nó image faz round-trip no formato Maestri { image: { _0: … } }', () => {
  const doc = decodeWorkspaceDocument({
    ...raw,
    payload: {
      ...raw.payload,
      nodes: [
        {
          id: 'FFFFFFFF-0000-0000-0000-0000000000AA',
          frame: [[300, 400], [360, 260]],
          zIndex: 7,
          isLocked: false,
          createdAt: '2026-08-27T00:00:00Z',
          lastModifiedAt: '2026-08-27T00:00:00Z',
          content: {
            image: {
              _0: {
                id: 'ffffffff-0000-0000-0000-0000000000ff',
                fileName: 'FFFFFFFF-0000-0000-0000-0000000000FF.png',
                title: 'Gráfico de vendas',
                mimeType: 'image/png',
                naturalWidth: 1920,
                naturalHeight: 1080,
                alt: 'barras por mês',
                addedAt: '2026-08-27T12:00:00Z'
              }
            }
          }
        }
      ]
    }
  })
  assert.equal(doc.droppedNodes, 0)
  const value = doc.payload.nodes[0].content.value
  assert.equal(value.title, 'Gráfico de vendas')
  assert.equal(value.mimeType, 'image/png')
  assert.equal(value.naturalWidth, 1920)
  assert.equal(value.alt, 'barras por mês')
  assert.equal(value.id, value.id.toUpperCase(), 'id da imagem normalizado para maiúsculas')

  const out = encodeWorkspaceDocument(doc.payload).payload.nodes[0].content
  assert.ok(out.image && '_0' in out.image, 'perdeu o embrulho da variante')
  assert.equal(out.image._0.title, 'Gráfico de vendas')
  assert.match(out.image._0.addedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
})

// ─── Editor de código ligado a um agente (cabo `data`, sem subir schema) ─────
// A asserção que importa aqui é a do schemaVersion: o par novo REUSA o cabo de
// dados justamente para não virar migração, e um `kind` próprio criado por
// descuido apareceria primeiro como este número mudando.

test('connectionKindForTypes reconhece terminal↔codeEditor nos dois sentidos', () => {
  assert.equal(connectionKindForTypes('terminal', 'codeEditor'), 'data')
  assert.equal(connectionKindForTypes('codeEditor', 'terminal'), 'data')
})

test('editor↔editor e editor↔portal continuam recusados', () => {
  assert.equal(connectionKindForTypes('codeEditor', 'codeEditor'), null)
  assert.equal(connectionKindForTypes('codeEditor', 'portal'), null)
  assert.equal(connectionKindForTypes('codeEditor', 'secretVault'), null)
})

test('conexão terminal↔codeEditor faz round-trip por dataConnections', () => {
  const doc = decodeWorkspaceDocument({
    ...raw,
    payload: {
      ...raw.payload,
      dataConnections: [
        {
          id: 'CCCCCCCC-0000-0000-0000-0000000000EE',
          terminalId: 'DDDDDDDD-0000-0000-0000-0000000000EE',
          dataNodeId: 'EEEEEEEE-0000-0000-0000-0000000000EE',
          createdAt: '2026-08-28T00:00:00Z',
          ropePoints: []
        }
      ]
    }
  })
  const conn = doc.payload.connections.find((c) => c.kind === 'data')
  assert.ok(conn, 'conexão data não foi decodificada')
  const back = encodeWorkspaceDocument(doc.payload)
  assert.equal(back.payload.dataConnections.length, 1)
  assert.equal(back.payload.dataConnections[0].dataNodeId, 'EEEEEEEE-0000-0000-0000-0000000000EE')
})

test('o cabo editor↔terminal não sobe o schemaVersion', () => {
  const doc = decodeWorkspaceDocument({
    ...raw,
    payload: {
      ...raw.payload,
      dataConnections: [
        {
          id: 'CCCCCCCC-0000-0000-0000-0000000000EF',
          terminalId: 'DDDDDDDD-0000-0000-0000-0000000000EE',
          dataNodeId: 'EEEEEEEE-0000-0000-0000-0000000000EE',
          createdAt: '2026-08-28T00:00:00Z',
          ropePoints: []
        }
      ]
    }
  })
  assert.equal(encodeWorkspaceDocument(doc.payload).schemaVersion, 7)
})

test('conexão terminal↔image vira kind "data" e volta para dataConnections', () => {
  const doc = decodeWorkspaceDocument({
    ...raw,
    payload: {
      ...raw.payload,
      dataConnections: [
        {
          id: 'CCCCCCCC-0000-0000-0000-0000000000BB',
          terminalId: 'DDDDDDDD-0000-0000-0000-0000000000BB',
          dataNodeId: 'EEEEEEEE-0000-0000-0000-0000000000BB',
          createdAt: '2026-08-27T00:00:00Z',
          ropePoints: []
        }
      ]
    }
  })
  const conn = doc.payload.connections.find((c) => c.kind === 'data')
  assert.ok(conn, 'conexão data não foi decodificada')
  const back = encodeWorkspaceDocument(doc.payload)
  assert.equal(back.payload.dataConnections.length, 1)
})

// ─── preferences.json: a posição das pílulas ─────────────────────────────────
//
// O arquivo é compartilhado com o app nativo Swift, cujo decoder IGNORA chave
// desconhecida — então o save dele apaga `dockPlacement` e `railPlacement`. A
// decisão foi gravar ali mesmo, de olhos abertos: perder isto devolve o padrão,
// que é a posição histórica, e o prejuízo é ínfimo. O que NÃO pode acontecer é
// a perda deixar a dock inalcançável.

test('preferences.json SEM as chaves novas carrega no padrão', () => {
  // É o arquivo de uma versão anterior — e também o que sobra depois de um save
  // do app nativo.
  const prefs = decodePreferences({ theme: 'dark', fontSize: 14 })
  assert.equal(prefs.dockPlacement, 'bottom/center')
  assert.equal(prefs.railPlacement, 'left/center')
  // E o resto do arquivo continua sendo lido normalmente.
  assert.equal(prefs.theme, 'dark')
  assert.equal(prefs.fontSize, 14)
})

test('sem as chaves da tira do monitor, ela nasce VISÍVEL no topo', () => {
  // O arquivo de uma versão anterior à tira — e o que sobra de um save do app
  // nativo. O padrão de `monitorDockVisible` é `true` de propósito: a tira
  // custa uma amostra a cada 2s, então desligá-la é um pedido legítimo, mas
  // nenhum estado em disco pode escondê-la sem deixar como trazê-la de volta.
  const prefs = decodePreferences({ theme: 'dark' })
  assert.equal(prefs.monitorPlacement, 'top/0.850')
  assert.equal(prefs.monitorDockVisible, true)
  // E o arquivo volta ao disco COM elas: quem regravar já persiste a posição.
  assert.ok('monitorPlacement' in prefs && 'monitorDockVisible' in prefs)
})

test('lixo nas chaves da tira também cai no padrão visível', () => {
  for (const ruim of ['', 'cima/meio', null, 42, { edge: 'top' }]) {
    const prefs = decodePreferences({ monitorPlacement: ruim, monitorDockVisible: ruim })
    assert.equal(prefs.monitorPlacement, 'top/0.850', `${JSON.stringify(ruim)} passou`)
    assert.equal(prefs.monitorDockVisible, true, `${JSON.stringify(ruim)} escondeu a tira`)
  }
})

test('desligada em disco, a tira CONTINUA desligada — é uma escolha do usuário', () => {
  // O contrapeso do teste acima: só o `false` explícito desliga, e ele
  // sobrevive ao round-trip.
  const prefs = decodePreferences({ monitorDockVisible: false, monitorPlacement: 'left/end' })
  assert.equal(prefs.monitorDockVisible, false)
  assert.equal(prefs.monitorPlacement, 'left/end')
})

test('com as chaves, carrega e regrava o que estava lá', () => {
  const prefs = decodePreferences({ dockPlacement: 'right/end', railPlacement: 'top/start' })
  assert.equal(prefs.dockPlacement, 'right/end')
  assert.equal(prefs.railPlacement, 'top/start')
})

test('valor inválido em disco NÃO esconde a dock', () => {
  // Um arquivo editado à mão, ou escrito por uma versão que não existe.
  for (const lixo of ['', 'cima/meio', 'bottom', null, 42, { edge: 'top' }]) {
    const prefs = decodePreferences({ dockPlacement: lixo })
    assert.equal(prefs.dockPlacement, 'bottom/center', `${JSON.stringify(lixo)} passou`)
  }
})

test('makePreferences nasce com a posição histórica das duas peças', () => {
  const base = makePreferences()
  assert.equal(base.dockPlacement, 'bottom/center')
  assert.equal(base.railPlacement, 'left/center')
  assert.equal(base.monitorPlacement, 'top/0.850')
  assert.equal(base.monitorDockVisible, true)
})

// ─── Widget (v6) ─────────────────────────────────────────────────────────────
// O caso de enum que hospeda painéis no canvas. O que estes testes protegem não
// é a renderização — é o formato: um `kind` que este binário não conhece tem de
// ATRAVESSAR intacto, senão o primeiro save de uma versão mais velha troca o
// widget do usuário por outro, em silêncio.

function widgetDoc(value) {
  return {
    ...raw,
    payload: {
      ...raw.payload,
      nodes: [
        {
          id: 'AAAAAAAA-0000-0000-0000-0000000000W1',
          frame: [[0, 0], [380, 460]],
          zIndex: 1,
          isLocked: false,
          createdAt: '2026-08-27T00:00:00Z',
          lastModifiedAt: '2026-08-27T00:00:00Z',
          content: { widget: { _0: value } }
        }
      ]
    }
  }
}

test('nó widget faz round-trip no formato Maestri { widget: { _0: … } }', () => {
  const doc = decodeWorkspaceDocument(
    widgetDoc({
      kind: 'git',
      projectId: 'BBBBBBBB-0000-0000-0000-0000000000W1',
      view: { tab: 'history' }
    })
  )
  const node = doc.payload.nodes[0]
  assert.equal(node.content.type, 'widget')
  assert.equal(node.content.value.kind, 'git')
  assert.equal(node.content.value.view.tab, 'history')

  const back = encodeWorkspaceDocument(doc.payload)
  const encoded = back.payload.nodes[0].content
  assert.ok(encoded.widget, 'não escreveu na chave widget')
  assert.equal(encoded.widget._0.kind, 'git')
  assert.equal(encoded.widget._0.projectId, 'BBBBBBBB-0000-0000-0000-0000000000W1')
  assert.equal(encoded.widget._0.view.tab, 'history')
})

test('kind desconhecido atravessa intacto em vez de virar outro widget', () => {
  const doc = decodeWorkspaceDocument(widgetDoc({ kind: 'tarefas', projectId: null, view: {} }))
  assert.equal(doc.droppedNodes, 0, 'o nó foi descartado')
  assert.equal(doc.payload.nodes[0].content.value.kind, 'tarefas')
  const back = encodeWorkspaceDocument(doc.payload)
  assert.equal(back.payload.nodes[0].content.widget._0.kind, 'tarefas')
})

test('monitor faz round-trip como widget/kind, sem subir a schemaVersion', () => {
  // O monitor é a segunda prova da promessa do widget ("todo painel futuro cabe
  // sem tocar no formato"): um kind a mais, nenhum passo em migrations.ts, e um
  // Atelier mais velho — ou o app nativo Swift — abre o arquivo sem lançar.
  const view = { blocks: 'both', interval: '2000', disk: '/Volumes/Work' }
  const doc = decodeWorkspaceDocument(widgetDoc({ kind: 'monitor', projectId: null, view }))
  assert.equal(doc.droppedNodes, 0)
  assert.equal(doc.payload.nodes[0].content.value.kind, 'monitor')

  const back = encodeWorkspaceDocument(doc.payload).payload.nodes[0].content
  assert.equal(back.widget._0.kind, 'monitor')
  assert.deepEqual(back.widget._0.view, view)
  assert.equal(back.widget._0.projectId, null, 'o monitor não pertence a projeto nenhum')
})

test('a amostra NÃO entra em view — só a configuração é persistida', () => {
  // Um monitor que gravasse cpuPct sujaria o autosave sessenta vezes por minuto
  // com dado que morre com a janela. `view` é [String: String], então um número
  // vindo de fora é descartado na leitura — e é a mesma guarda que impede o
  // acidente de alguém decidir gravar a amostra ali.
  const doc = decodeWorkspaceDocument(
    widgetDoc({ kind: 'monitor', projectId: null, view: { blocks: 'pc', cpuPct: 47.2 } })
  )
  const view = doc.payload.nodes[0].content.value.view
  assert.equal(view.blocks, 'pc')
  assert.equal('cpuPct' in view, false, 'uma amostra foi parar no workspace')
})

test('quadro de TODO faz round-trip como widget/kind, sem subir a versão', () => {
  // Terceira prova da promessa do widget. O que vai no `view` é só o PONTEIRO
  // para o arquivo — o quadro em si mora em `todos/<file>.json`, porque ele é
  // reescrito a cada cartão movido e `view` proíbe alta frequência.
  const view = { title: 'Sprint do editor', file: 'abc-123', mode: 'kanban' }
  const doc = decodeWorkspaceDocument(widgetDoc({ kind: 'todo', projectId: null, view }))
  assert.equal(doc.droppedNodes, 0)
  assert.equal(doc.payload.nodes[0].content.value.kind, 'todo')

  const back = encodeWorkspaceDocument(doc.payload).payload.nodes[0].content
  assert.equal(back.widget._0.kind, 'todo')
  assert.deepEqual(back.widget._0.view, view)
})

test('os CARTÕES não entram no workspace.json — só o nome do arquivo', () => {
  // Um quadro serializado em `view` seria um campo de vários KB reescrito a cada
  // arrasto, dentro do arquivo que o app nativo Swift também grava. `view` é
  // [String: String], então um array de itens é descartado na leitura — e é a
  // mesma guarda que impede alguém de decidir gravá-los ali.
  const doc = decodeWorkspaceDocument(
    widgetDoc({
      kind: 'todo',
      projectId: null,
      view: { file: 'abc', items: [{ id: 'x', title: 'nao deveria estar aqui' }] }
    })
  )
  const view = doc.payload.nodes[0].content.value.view
  assert.equal(view.file, 'abc')
  assert.equal('items' in view, false, 'os cartões foram parar no workspace.json')
})

test('view descarta o que não é string — o Swift lê [String: String]', () => {
  const doc = decodeWorkspaceDocument(
    widgetDoc({ kind: 'git', projectId: null, view: { tab: 'changes', linhas: 40 } })
  )
  const view = doc.payload.nodes[0].content.value.view
  assert.equal(view.tab, 'changes')
  assert.equal('linhas' in view, false, 'um número foi gravado num mapa de strings')
})

// ─── Grupos (sem subir a versão) ─────────────────────────────────────────────
// A moldura é uma chave a mais no TOPO do payload, não um caso a mais no enum
// de conteúdo — é o que faz o app nativo Swift continuar abrindo o arquivo. O
// que estes testes protegem é a leitura defensiva: a lista de membros vem de um
// arquivo que outra ferramenta pode ter escrito.

const NODE_A = raw.payload.nodes[0].id.toUpperCase()

function groupsDoc(groups) {
  return { ...raw, payload: { ...raw.payload, groups } }
}

function aGroup(patch = {}) {
  return {
    id: 'CCCCCCCC-0000-0000-0000-0000000000G1',
    title: 'Infra',
    frame: [[10, 20], [400, 300]],
    nodeIds: [NODE_A],
    color: '#E6F0FF',
    isCollapsed: false,
    createdAt: '2026-08-27T00:00:00Z',
    lastModifiedAt: '2026-08-27T00:00:00Z',
    ...patch
  }
}

test('grupo faz round-trip sem perda', () => {
  const doc = decodeWorkspaceDocument(groupsDoc([aGroup()]))
  const g = doc.payload.groups[0]
  assert.equal(g.title, 'Infra')
  assert.deepEqual(g.frame, { x: 10, y: 20, width: 400, height: 300 })
  assert.deepEqual(g.nodeIds, [NODE_A])
  assert.equal(g.color, '#E6F0FF')

  const back = encodeWorkspaceDocument(doc.payload)
  const encoded = back.payload.groups[0]
  assert.deepEqual(encoded.frame, [[10, 20], [400, 300]], 'frame não saiu como [[x,y],[w,h]]')
  assert.deepEqual(encoded.nodeIds, [NODE_A])
  assert.equal(encoded.isCollapsed, false)
})

test('grupo não sobe o schemaVersion — o app nativo continua abrindo', () => {
  // O número é o da versão CORRENTE: o ponto do teste é que a moldura de grupo
  // não o move, e ele muda quando o enum de conteúdo ganha um caso.
  const doc = decodeWorkspaceDocument(groupsDoc([aGroup()]))
  assert.equal(encodeWorkspaceDocument(doc.payload).schemaVersion, 7)
})

test('id órfão em nodeIds é filtrado, e o grupo sobrevive', () => {
  const doc = decodeWorkspaceDocument(
    groupsDoc([aGroup({ nodeIds: [NODE_A, 'DEADBEEF-0000-0000-0000-000000000000'] })])
  )
  assert.deepEqual(doc.payload.groups[0].nodeIds, [NODE_A])
  assert.equal(doc.droppedNodes, 0, 'grupo com id órfão não é perda de conteúdo')
})

test('membro repetido em dois grupos fica no primeiro', () => {
  const doc = decodeWorkspaceDocument(
    groupsDoc([
      aGroup(),
      aGroup({ id: 'CCCCCCCC-0000-0000-0000-0000000000G2', title: 'Outro' })
    ])
  )
  assert.deepEqual(doc.payload.groups[0].nodeIds, [NODE_A])
  assert.deepEqual(doc.payload.groups[1].nodeIds, [], 'o mesmo nó ficou em dois grupos')
})

test('membro repetido DENTRO do mesmo grupo entra uma vez só', () => {
  const doc = decodeWorkspaceDocument(groupsDoc([aGroup({ nodeIds: [NODE_A, NODE_A] })]))
  assert.deepEqual(doc.payload.groups[0].nodeIds, [NODE_A])
})

test('frame inválido descarta o grupo — sem moldura não há o que desenhar', () => {
  const doc = decodeWorkspaceDocument(groupsDoc([aGroup({ frame: 'nada' }), aGroup({ id: 'CCCCCCCC-0000-0000-0000-0000000000G3' })]))
  assert.equal(doc.payload.groups.length, 1)
})

test('payload sem a chave groups decodifica como lista vazia', () => {
  const doc = decodeWorkspaceDocument(raw)
  assert.deepEqual(doc.payload.groups, [], 'arquivo antigo virou grupos indefinidos')
  assert.deepEqual(encodeWorkspaceDocument(doc.payload).payload.groups, [])
})

test('nodeIds chega em minúsculo e sai maiúsculo, como todo UUID do formato', () => {
  const doc = decodeWorkspaceDocument(groupsDoc([aGroup({ nodeIds: [NODE_A.toLowerCase()] })]))
  assert.deepEqual(doc.payload.groups[0].nodeIds, [NODE_A])
})

// O botão é o primeiro teste da promessa do widget: "todo widget futuro cabe
// sem tocar no formato". Se algum destes falhar, o formato mudou e o app nativo
// (ou uma versão mais velha deste binário) perde a configuração do usuário.

test('botão faz round-trip como widget/button, com a config inteira em view', () => {
  const view = {
    label: 'Subir a app',
    icon: 'play',
    color: '#34C759',
    action: 'command',
    command: 'npm run dev',
    cwd: '/home/dev/app',
    confirm: '1'
  }
  const doc = decodeWorkspaceDocument(widgetDoc({ kind: 'button', projectId: null, view }))
  const value = doc.payload.nodes[0].content.value
  assert.equal(value.kind, 'button')
  assert.deepEqual(value.view, view)

  const back = encodeWorkspaceDocument(doc.payload).payload.nodes[0].content
  assert.equal(back.widget._0.kind, 'button')
  assert.deepEqual(back.widget._0.view, view)
})

test('chave desconhecida no view de um botão sobrevive ao round-trip', () => {
  // Uma versão mais nova pode gravar `shortcut` aqui. Perder essa chave no save
  // seria a mesma perda silenciosa que o formato do botão veio evitar.
  const view = { label: 'X', action: 'command', command: 'ls', shortcut: 'cmd+1' }
  const doc = decodeWorkspaceDocument(widgetDoc({ kind: 'button', projectId: null, view }))
  const back = encodeWorkspaceDocument(doc.payload).payload.nodes[0].content
  assert.equal(back.widget._0.view.shortcut, 'cmd+1')
})

test('valor não-string no view de um botão é filtrado', () => {
  const doc = decodeWorkspaceDocument(
    widgetDoc({ kind: 'button', projectId: null, view: { label: 'X', confirm: true } })
  )
  const view = doc.payload.nodes[0].content.value.view
  assert.equal(view.label, 'X')
  assert.equal('confirm' in view, false, 'um booleano foi gravado num mapa de strings')
})

test('schemaVersion e type ficam corretos na raiz', () => {
  assert.equal(reencoded.schemaVersion, 7)
  assert.equal(reencoded.type, 'workspace')
})

await cleanup()

console.log(`\n${passed} passaram, ${failed} falharam\n`)
process.exit(failed === 0 ? 0 : 1)
