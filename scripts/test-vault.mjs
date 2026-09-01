/**
 * Cofre — as funções puras de `shared/vault.ts` e a subida de schema v6 → v7.
 *
 * As três funções de `shared/vault.ts` não são utilitários: são TRAVAS. O
 * `maskSecrets` é o que impede um segredo já revelado de reaparecer no
 * scrollback; o `sameOrigin` é o que impede o `portal login` de digitar a senha
 * do GitHub no formulário de um atacante; o `isValidKeyName` é o que impede um
 * nome de chave de virar uma variável de ambiente quebrada no spawn do PTY.
 * Cada uma é testada pelo caso que a derruba, não pelo caso feliz.
 *
 * A migração é o outro lado: a v7 NÃO transforma dado nenhum, e é exatamente
 * isso que precisa ser verificado — um documento v6 atravessa intacto, e o nó
 * de cofre e o cabo `secret` sobrevivem ao round-trip.
 *
 * Uso: node scripts/test-vault.mjs
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as esbuild from 'esbuild'

const ROOT = resolve(import.meta.dirname, '..')

const outdir = await mkdtemp(join(tmpdir(), 'atelier-vault-'))
const outfile = join(outdir, 'vault.mjs')
await esbuild.build({
  stdin: {
    contents: `
      export * from './src/shared/vault.ts'
      export { connectionKindForTypes, CONNECTABLE_TYPES } from './src/shared/types.ts'
      export { decodeWorkspaceDocument, encodeWorkspaceDocument } from './src/main/core/models/workspace.ts'
      export { decodeNodeContent, encodeNodeContent, makeSecretVaultContent } from './src/main/core/models/node-content.ts'
      export { migrateWorkspaceDocument } from './src/main/core/persistence/migrations.ts'
      export { Constants } from './src/main/core/constants.ts'
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

const mod = await import(pathToFileURL(outfile).href)
const { maskSecrets, isValidKeyName, sameOrigin, originOf, SECRET_MASK } = mod
const { decodeVaultFile, emptyVaultFile, withNewEntry } = mod
const { rotationReason, VAULT_ROTATE_AFTER_DAYS } = mod
const { connectionKindForTypes, CONNECTABLE_TYPES } = mod
const { decodeWorkspaceDocument, encodeWorkspaceDocument } = mod
const { decodeNodeContent, encodeNodeContent, makeSecretVaultContent } = mod
const { migrateWorkspaceDocument, Constants } = mod
const { exportLine } = mod
// O CLI é CommonJS e não passa pelo bundle: a guarda de TTY mora nele porque só
// ele sabe se a saída é a tela.
const cli = await import(pathToFileURL(join(ROOT, 'resources/atelier.cjs')).href)
const { refusesExportToTTY } = cli.default ?? cli

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

console.log('\ncofre: shared/vault.ts e a migração v6 → v7\n')

// ─── maskSecrets ─────────────────────────────────────────────────────────────

test('mascara o valor no MEIO do chunk, não só na borda', () => {
  const out = maskSecrets('psql "postgres://u:s3nha@h/db" ok', ['s3nha'])
  assert.equal(out, `psql "postgres://u:${SECRET_MASK}@h/db" ok`)
})

test('mascara TODAS as ocorrências do mesmo valor', () => {
  assert.equal(maskSecrets('a X b X c', ['X']), `a ${SECRET_MASK} b ${SECRET_MASK} c`)
})

test('mascara vários valores diferentes no mesmo texto', () => {
  const out = maskSecrets('user=alice pass=hunter2', ['alice', 'hunter2'])
  assert.equal(out, `user=${SECRET_MASK} pass=${SECRET_MASK}`)
})

test('valor vazio NÃO mascara tudo — a falha que apagaria o scrollback inteiro', () => {
  assert.equal(maskSecrets('texto normal', ['']), 'texto normal')
  assert.equal(maskSecrets('texto normal', ['   ']), 'texto normal')
  assert.equal(maskSecrets('texto normal', ['', 'normal']), `texto ${SECRET_MASK}`)
})

test('valor que é PREFIXO de outro não deixa o resto do longo em claro', () => {
  // Mascarar 'abc' primeiro deixaria 'def' visível — por isso os valores são
  // varridos do mais longo para o mais curto.
  const out = maskSecrets('token=abcdef', ['abc', 'abcdef'])
  assert.equal(out, `token=${SECRET_MASK}`)
  assert.ok(!out.includes('def'), 'sobrou pedaço do segredo longo em claro')
})

test('valor com metacaractere de regex é tratado como literal', () => {
  const out = maskSecrets('p=a.*b|c e a1b', ['a.*b|c'])
  assert.equal(out, `p=${SECRET_MASK} e a1b`, 'o valor virou expressão regular')
})

test('texto sem nenhum dos valores volta idêntico', () => {
  assert.equal(maskSecrets('nada aqui', ['x', 'y']), 'nada aqui')
  assert.equal(maskSecrets('nada aqui', []), 'nada aqui')
})

// ─── isValidKeyName ──────────────────────────────────────────────────────────

test('aceita o que sobrevive a virar variável de ambiente', () => {
  for (const name of ['DB_URL', '_x', 'A1', 'aB_9', '_']) {
    assert.equal(isValidKeyName(name), true, `recusou ${name}`)
  }
})

test('recusa o que quebraria no spawn do PTY', () => {
  for (const name of ['', '1DB', 'DB-URL', 'DB URL', 'DB.URL', 'DB$', 'DB\nX', 'ÁGUA']) {
    assert.equal(isValidKeyName(name), false, `aceitou ${JSON.stringify(name)}`)
  }
})

// ─── sameOrigin ──────────────────────────────────────────────────────────────

test('http NÃO casa com https — o downgrade é o ataque', () => {
  assert.equal(sameOrigin('http://github.com', 'https://github.com'), false)
})

test('subdomínio é outra origem', () => {
  assert.equal(sameOrigin('https://github.com', 'https://gist.github.com'), false)
  assert.equal(sameOrigin('https://github.com', 'https://github.com.evil.io'), false)
})

test('porta diferente é outra origem; porta PADRÃO é a mesma', () => {
  assert.equal(sameOrigin('https://x.com:8443', 'https://x.com'), false)
  assert.equal(sameOrigin('https://x.com:443', 'https://x.com'), true)
  assert.equal(sameOrigin('http://x.com:80', 'http://x.com'), true)
})

test('caminho e query não entram na comparação — origem é esquema+host+porta', () => {
  assert.equal(sameOrigin('https://github.com', 'https://github.com/login?a=1'), true)
})

test('null, vazio e URL torta recusam — nunca "passa por omissão"', () => {
  assert.equal(sameOrigin(null, 'https://x.com'), false)
  assert.equal(sameOrigin('https://x.com', null), false)
  assert.equal(sameOrigin('', ''), false)
  assert.equal(sameOrigin('nao é url', 'https://x.com'), false)
  assert.equal(sameOrigin(undefined, undefined), false)
})

test('originOf normaliza para esquema://host, sem porta padrão', () => {
  assert.equal(originOf('https://github.com/a/b?c=1#d'), 'https://github.com')
  assert.equal(originOf('https://github.com:443/'), 'https://github.com')
  assert.equal(originOf('https://x.com:8443/'), 'https://x.com:8443')
  assert.equal(originOf('não é url'), null)
})

// ─── VaultFile ───────────────────────────────────────────────────────────────

test('cofre vazio é version 1, kdf null e nenhuma entrada', () => {
  assert.deepEqual(emptyVaultFile(), { version: 1, kdf: null, entries: [] })
})

test('cofre de uma versão FUTURA é recusado inteiro, não lido como v1', () => {
  // Ler uma v2 como v1 faria o writeVault seguinte regravar o arquivo sem a
  // camada de passphrase que o `kdf` reserva — perda silenciosa. Recusar aqui é
  // o que faz o cofre aparecer BLOQUEADO na UI, com o arquivo intacto no disco.
  assert.equal(decodeVaultFile({ version: 2, kdf: { salt: 'x' }, entries: [] }), null)
  assert.equal(decodeVaultFile({ version: 99, entries: [{ key: 'K', value: 'v' }] }), null)
})

test('versão ausente ou não numérica vale como 1 — é o que todo .vault tem hoje', () => {
  assert.deepEqual(decodeVaultFile({ entries: [] }), { version: 1, kdf: null, entries: [] })
  assert.deepEqual(decodeVaultFile({ version: 'x', entries: [] }), {
    version: 1,
    kdf: null,
    entries: []
  })
  assert.deepEqual(decodeVaultFile({ version: 1, entries: [] }), {
    version: 1,
    kdf: null,
    entries: []
  })
})

test('decode do cofre descarta entrada sem chave e completa os defaults', () => {
  const file = decodeVaultFile({
    version: 1,
    entries: [
      { key: 'DB_URL', value: 'postgres://x' },
      { value: 'órfã sem nome' },
      { key: 'GH', value: 'v', origin: 'https://github.com', inEnv: true, note: 'n', updatedAt: 'T' }
    ]
  })
  assert.equal(file.entries.length, 2)
  // Default de `origin` é null: quem não declarou, não autorizou.
  assert.deepEqual(file.entries[0], {
    key: 'DB_URL',
    value: 'postgres://x',
    origin: null,
    inEnv: false,
    note: null,
    updatedAt: '',
    // Procedência ausente vale usuário — ver rotationReason.
    source: 'user'
  })
  assert.equal(file.entries[1].origin, 'https://github.com')
  assert.equal(file.entries[1].inEnv, true)
})

// ─── withNewEntry: a única escrita que o agente tem ──────────────────────────

function entry(key, over = {}) {
  return {
    key,
    value: 'v',
    origin: null,
    inEnv: false,
    note: null,
    updatedAt: '2026-08-28T00:00:00Z',
    ...over
  }
}

test('acrescenta a chave e devolve um arquivo NOVO — o original não muda', () => {
  const file = emptyVaultFile()
  const next = withNewEntry(file, entry('API_KEY'))
  assert.equal(next.entries.length, 1)
  assert.equal(next.entries[0].key, 'API_KEY')
  assert.equal(file.entries.length, 0)
})

test('chave que já existe é RECUSADA — criar é a única escrita do agente', () => {
  const file = { ...emptyVaultFile(), entries: [entry('API_KEY', { value: 'do usuário' })] }
  assert.equal(withNewEntry(file, entry('API_KEY', { value: 'do agente' })), null)
  assert.equal(file.entries[0].value, 'do usuário')
})

test('a recusa é por nome exato: maiúscula/minúscula são chaves diferentes', () => {
  const file = { ...emptyVaultFile(), entries: [entry('API_KEY')] }
  assert.ok(withNewEntry(file, entry('api_key')))
})

test('a lista sai ordenada por nome, não por ordem de escrita', () => {
  let file = emptyVaultFile()
  for (const k of ['ZETA', 'ALFA', 'MEIO']) file = withNewEntry(file, entry(k))
  assert.deepEqual(file.entries.map((e) => e.key), ['ALFA', 'MEIO', 'ZETA'])
})

test('version e kdf sobrevivem à escrita — o arquivo continua legível', () => {
  const next = withNewEntry(emptyVaultFile(), entry('K'))
  assert.equal(next.version, 1)
  assert.equal(next.kdf, null)
})

// ─── rotationReason: quando o nó pede a troca ────────────────────────────────

const DIA = 86_400_000
const AGORA = Date.parse('2026-08-28T00:00:00Z')
const dias = (n) => new Date(AGORA - n * DIA).toISOString()

test('chave gravada por AGENTE pede troca no mesmo dia — o valor já foi visto', () => {
  assert.equal(rotationReason({ source: 'agent', updatedAt: dias(0) }, AGORA), 'agent')
})

test('chave do usuário só pede troca DEPOIS do limite', () => {
  const nova = { source: 'user', updatedAt: dias(VAULT_ROTATE_AFTER_DAYS - 1) }
  const velha = { source: 'user', updatedAt: dias(VAULT_ROTATE_AFTER_DAYS + 1) }
  assert.equal(rotationReason(nova, AGORA), null)
  assert.equal(rotationReason(velha, AGORA), 'stale')
})

test('agente vence idade: o motivo mostrado é o de agora, não o de manutenção', () => {
  assert.equal(rotationReason({ source: 'agent', updatedAt: dias(500) }, AGORA), 'agent')
})

test('data ausente ou torta NÃO marca — ícone que mente ensina a ser ignorado', () => {
  assert.equal(rotationReason({ source: 'user', updatedAt: '' }, AGORA), null)
  assert.equal(rotationReason({ source: 'user', updatedAt: 'ontem' }, AGORA), null)
  assert.equal(rotationReason({}, AGORA), null)
})

test('source ausente vale usuário — cofre antigo não vira um mar de vermelho', () => {
  const back = decodeVaultFile({ entries: [{ key: 'K', value: 'v', updatedAt: dias(1) }] })
  assert.equal(back.entries[0].source, 'user')
  assert.equal(rotationReason(back.entries[0], AGORA), null)
})

// ─── O nó no enum ────────────────────────────────────────────────────────────

test('secretVault é conectável, e o cabo com terminal e com portal é "secret"', () => {
  assert.ok(CONNECTABLE_TYPES.includes('secretVault'))
  assert.equal(connectionKindForTypes('terminal', 'secretVault'), 'secret')
  assert.equal(connectionKindForTypes('secretVault', 'terminal'), 'secret')
  assert.equal(connectionKindForTypes('portal', 'secretVault'), 'secret')
  assert.equal(connectionKindForTypes('secretVault', 'portal'), 'secret')
})

test('cofre com cofre NÃO conecta — não há sentido nesse cabo', () => {
  assert.equal(connectionKindForTypes('secretVault', 'secretVault'), null)
  assert.equal(connectionKindForTypes('stickyNote', 'secretVault'), null)
})

test('round-trip do conteúdo: as chaves sobrevivem e NENHUM valor é gravado', () => {
  const content = {
    type: 'secretVault',
    value: {
      ...makeSecretVaultContent('Pessoal'),
      keys: [
        {
          key: 'GITHUB_PASS',
          inEnv: false,
          origin: 'https://github.com',
          note: 'conta pessoal',
          updatedAt: '',
          source: 'user'
        },
        { key: 'DB_URL', inEnv: true, origin: null, note: null, updatedAt: '', source: 'user' }
      ]
    }
  }
  const encoded = encodeNodeContent(content)
  const json = JSON.stringify(encoded)
  assert.ok(!json.includes('"value"'), 'o encode do cofre carregou um campo de valor')

  const back = decodeNodeContent(encoded)
  assert.equal(back.type, 'secretVault')
  assert.deepEqual(back.value.keys, content.value.keys)
  assert.equal(back.value.name, 'Pessoal')
  assert.equal(back.value.locked, false)
})

test('campo de valor injetado no arquivo é DESCARTADO na releitura', () => {
  const back = decodeNodeContent({
    secretVault: {
      _0: {
        id: 'CCCCCCCC-0000-0000-0000-0000000000V1',
        name: 'Cofre',
        locked: false,
        keys: [{ key: 'DB_URL', inEnv: true, origin: null, note: null, value: 'segredo em claro' }]
      }
    }
  })
  assert.deepEqual(back.value.keys, [
    { key: 'DB_URL', inEnv: true, origin: null, note: null, updatedAt: '', source: 'user' }
  ])
  assert.ok(!JSON.stringify(back).includes('segredo em claro'))
})

test('chave repetida entra uma vez só', () => {
  const back = decodeNodeContent({
    secretVault: {
      _0: {
        id: 'CCCCCCCC-0000-0000-0000-0000000000V2',
        name: 'Cofre',
        keys: [{ key: 'K' }, { key: 'K' }, { key: '' }]
      }
    }
  })
  assert.deepEqual(back.value.keys.map((k) => k.key), ['K'])
})

// ─── Migração v6 → v7 ────────────────────────────────────────────────────────

const VAULT_NODE_ID = 'AAAAAAAA-0000-0000-0000-0000000000V1'
const TERM_NODE_ID = 'AAAAAAAA-0000-0000-0000-0000000000T1'

function docV6(extra = {}) {
  return {
    schemaVersion: 6,
    type: 'workspace',
    payload: {
      id: '00000000-0000-0000-0000-000000000001',
      name: 'Herdado',
      icon: 'folder',
      isPinned: false,
      locationType: 'local',
      workingDirectory: '/tmp/test',
      canvasOrigin: [9800, 8500],
      canvasZoom: 1,
      nodes: [
        {
          id: TERM_NODE_ID,
          frame: [[0, 0], [560, 360]],
          zIndex: 1,
          isLocked: false,
          createdAt: '2026-05-16T00:00:00Z',
          lastModifiedAt: '2026-05-16T00:00:00Z',
          content: { terminal: { _0: { name: 'Agent', id: 'BBBBBBBB-0000-0000-0000-000000000001' } } }
        }
      ],
      connections: [],
      noteConnections: [],
      portalConnections: [],
      dataConnections: [],
      portalToPortalConnections: [],
      noteToNoteConnections: [],
      crossFloorConnections: [],
      floors: [],
      drawings: [],
      groups: [],
      createdAt: '2026-05-16T00:00:00Z',
      lastModifiedAt: '2026-05-16T00:00:00Z',
      ...extra
    }
  }
}

test('a versão do schema é 8', () => {
  // A asserção é do NÚMERO, e não de uma constante contra ela mesma: a subida de
  // versão é uma decisão deliberada (a v8 acrescentou `clockActionConnections`), e
  // este teste é o que obriga quem a mexer a olhar as migrações antes.
  assert.equal(Constants.schemaVersion, 8)
})

test('v6 → a versão corrente sobe o número e NÃO transforma o payload', () => {
  const before = docV6()
  const after = migrateWorkspaceDocument(structuredClone(before))
  assert.equal(after.schemaVersion, Constants.schemaVersion)
  assert.deepEqual(after.payload, before.payload, 'a migração mexeu no conteúdo')
})

test('documento já na versão corrente atravessa intocado', () => {
  const atual = { ...docV6(), schemaVersion: Constants.schemaVersion }
  assert.deepEqual(migrateWorkspaceDocument(structuredClone(atual)), atual)
})

test('v1 → a versão corrente cria a lista secretConnections vazia, como as outras', () => {
  const v1 = { schemaVersion: 1, type: 'workspace', payload: { nodes: [] } }
  const after = migrateWorkspaceDocument(v1)
  assert.equal(after.schemaVersion, Constants.schemaVersion)
  assert.deepEqual(after.payload.secretConnections, [])
})

test('nó de cofre sobrevive a save → load, com as chaves e sem valor', () => {
  const doc = docV6({
    nodes: [
      {
        id: VAULT_NODE_ID,
        frame: [[100, 100], [320, 280]],
        zIndex: 2,
        isLocked: false,
        createdAt: '2026-05-16T00:00:00Z',
        lastModifiedAt: '2026-05-16T00:00:00Z',
        content: {
          secretVault: {
            _0: {
              id: 'CCCCCCCC-0000-0000-0000-0000000000V9',
              name: 'Pessoal',
              locked: false,
              keys: [
                {
                  key: 'GITHUB_PASS',
                  inEnv: false,
                  origin: 'https://github.com',
                  note: null,
                  updatedAt: '',
                  source: 'user'
                }
              ]
            }
          }
        }
      }
    ]
  })

  const { payload, droppedNodes } = decodeWorkspaceDocument(doc)
  assert.equal(droppedNodes, 0, 'o cofre foi descartado no decode')
  const node = payload.nodes.find((n) => n.id === VAULT_NODE_ID)
  assert.equal(node.content.type, 'secretVault')
  assert.deepEqual(node.content.value.keys, [
    {
      key: 'GITHUB_PASS',
      inEnv: false,
      origin: 'https://github.com',
      note: null,
      updatedAt: '',
      source: 'user'
    }
  ])

  const back = encodeWorkspaceDocument(payload)
  assert.equal(back.schemaVersion, Constants.schemaVersion)
  const encodedNode = back.payload.nodes.find((n) => n.id === VAULT_NODE_ID)
  assert.deepEqual(encodedNode.content.secretVault._0.keys, node.content.value.keys)
})

test('secretConnections é reconstruída no round-trip, com os campos neutros', () => {
  const doc = docV6({
    secretConnections: [
      {
        id: 'DDDDDDDD-0000-0000-0000-0000000000C1',
        nodeIdA: TERM_NODE_ID,
        nodeIdB: VAULT_NODE_ID,
        ropePoints: [],
        createdAt: '2026-05-16T00:00:00Z'
      }
    ]
  })

  const { payload } = decodeWorkspaceDocument(doc)
  const conn = payload.connections.find((c) => c.kind === 'secret')
  assert.ok(conn, 'o cabo de cofre sumiu no decode')
  assert.equal(conn.nodeIdA, TERM_NODE_ID)
  assert.equal(conn.nodeIdB, VAULT_NODE_ID)

  const back = encodeWorkspaceDocument(payload)
  assert.deepEqual(back.payload.secretConnections, [
    {
      id: conn.id,
      createdAt: conn.createdAt,
      nodeIdA: TERM_NODE_ID,
      nodeIdB: VAULT_NODE_ID,
      ropePoints: []
    }
  ])
})

test('um v6 sem a chave secretConnections vira lista vazia, não undefined', () => {
  const { payload } = decodeWorkspaceDocument(docV6())
  const back = encodeWorkspaceDocument(payload)
  assert.deepEqual(back.payload.secretConnections, [])
})


// ─── `vault env --export`: o segredo vai para o AMBIENTE, não para a tela ─────
//
// O verbo nasceu de uma medição: o cabo de cofre injeta as chaves no BOOT do
// PTY, e um cabo ligado depois não alcança processo vivo — o
// `/proc/<pid>/environ` de um nó recém-cabeado não tinha nenhuma delas. Sem
// isto, sobrava `vault get`, que traz o segredo para o CONTEXTO do agente.

test('exportLine cita com aspas simples — senha com $ não vira expansão', () => {
  assert.equal(exportLine('K', 'abc'), "export K='abc'")
  assert.equal(exportLine('PGPASSWORD', 'a$b'), "export PGPASSWORD='a$b'")
  assert.equal(exportLine('K', 'com espaço'), "export K='com espaço'")
})

test('exportLine neutraliza `$(...)` — a citação errada não falha, ela OBEDECE', () => {
  // Em aspas duplas isto viraria execução de comando no shell que faz o eval.
  const line = exportLine('K', '$(rm -rf /)')
  assert.equal(line, "export K='$(rm -rf /)'")
  assert.ok(!line.includes('"'), 'aspas duplas em nenhum lugar')
})

test('exportLine fecha, escapa e reabre a aspa simples', () => {
  // A única coisa que não cabe dentro de aspas simples é a própria aspa.
  assert.equal(exportLine('K', "ab'cd"), "export K='ab'\\''cd'")
})

test('exportLine sobrevive a quebra de linha no valor', () => {
  const line = exportLine('K', 'linha1\nlinha2')
  assert.ok(line.startsWith("export K='linha1\nlinha2'"), line)
})

test('o CLI recusa imprimir segredo quando a saída é a TELA', () => {
  // A guarda mora no CLI porque só ele sabe para onde a saída vai: o app
  // responde por socket e não enxerga o outro lado.
  assert.equal(refusesExportToTTY('vault', ['vault', 'env', '--export'], true), true)
  assert.equal(refusesExportToTTY('vault', ['vault', 'env', '--export'], false), false, 'num $( ) ele PRECISA rodar')
  assert.equal(refusesExportToTTY('vault', ['vault', 'env'], true), false, 'listar nomes nunca foi problema')
  assert.equal(refusesExportToTTY('list', ['list'], true), false)
})

await rm(outdir, { recursive: true, force: true })

console.log(`\n${passed} passaram, ${failed} falharam\n`)
process.exit(failed === 0 ? 0 : 1)
