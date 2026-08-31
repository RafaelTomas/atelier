/**
 * Gerador do workspace de demonstração — Fatia 3 do plano
 * (docs/2026-08-30-PLANO-workspace-de-demonstracao.md).
 *
 * POR QUE um script e não um `.json` versionado: o `schemaVersion` está em 7 e
 * sobe a cada tipo de nó novo. Um arquivo fixo apodrece — o app abre em modo
 * seguro e trava o autosave. A única defesa é montar o `WorkspacePayload` em
 * memória e serializá-lo com o MESMO codec do app (`encodeWorkspaceDocument`),
 * via `makeCanvasNode` / `makeConnection`. Assim o arquivo nunca diverge do
 * formato nativo, e o round-trip do codec roda em CI (Fatia 7).
 *
 * DECISÕES desta fatia:
 *  - Só os 14 nós e 11 cabos da seção 2. Os satélites (nota em disco, quadro
 *    de TODO, cofre, tabela, imagem) entram VAZIOS / com default — escrevê-los
 *    a partir de `fixtures/demo/` é a Fatia 4.
 *  - O núcleo é TypeScript: bundlamos com esbuild pelo mesmo caminho que o
 *    `scripts/smoke-headless.mjs` usa — `stdin.contents` com imports RELATIVOS
 *    (`./src/...`) e `resolveDir: ROOT`. NÃO se passa `sourcefile`: no Windows
 *    o esbuild passaria a resolver os imports a partir da pasta do sourcefile,
 *    não do `resolveDir`, e o bundle quebra. `electron` fica external.
 *  - SEGURANÇA: por padrão aponta `ATELIER_HOME` para `~/.atelier-dev` (o do
 *    `npm run dev`). RECUSA rodar se o diretório resolvido for o `~/.atelier`
 *    real — onde o app do usuário está rodando agora — a menos que receba
 *    `--force`. Mesma doutrina do `dev:realdata`.
 *  - `workspaceId` FIXO: rodar de novo sobrescreve a mesma pasta. A demo é
 *    idempotente de propósito (regenerar antes de cada sessão limpa o canvas
 *    "sujo" da anterior).
 *  - Antes de gravar, o payload passa uma vez por `decode(encode(x))`: o codec
 *    é idempotente, e normalizar aqui garante que o arquivo em disco satisfaz
 *    `encode(decode(x)) == x` sem depender de cada `make*` já emitir a forma
 *    canônica.
 *
 * Uso:
 *   ATELIER_HOME=/tmp/demo-home node scripts/make-demo-workspace.mjs
 *   node scripts/make-demo-workspace.mjs --force     # aceita o ~/.atelier real
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as esbuild from 'esbuild'

const ROOT = resolve(import.meta.dirname, '..')
const FORCE = process.argv.includes('--force')

// ─── ID fixo da demo ─────────────────────────────────────────────────────────
// Maiúsculo porque o codec normaliza todo UUID para caixa alta (coding.ts).
const DEMO_WORKSPACE_ID = 'DEC0DEC0-0DE3-4DE3-9DE3-D3D0DEC0DEC0'

// ─── SEGURANÇA: resolve ATELIER_HOME e recusa o diretório real ────────────────
// Sem override, a demo mora ao lado do `npm run dev`, nunca no ~/.atelier real.
if (!process.env.ATELIER_HOME || !process.env.ATELIER_HOME.trim()) {
  process.env.ATELIER_HOME = join(homedir(), '.atelier-dev')
}
process.env.NODE_ENV ||= 'development'

// ─── Bundla o núcleo (TS) — mesmo caminho do smoke-headless ───────────────────
const outdir = await mkdtemp(join(tmpdir(), 'atelier-demo-core-'))
const outfile = join(outdir, 'core.mjs')
await esbuild.build({
  stdin: {
    contents: `
      export { paths, dataDir, defaultDataDir } from './src/main/core/persistence/paths.ts'
      export { persistence } from './src/main/core/persistence/persistence-manager.ts'
      export {
        makeCanvasNode, makeConnection, makeNodeGroup, makeWorkspacePayload,
        encodeWorkspaceDocument, decodeWorkspaceDocument
      } from './src/main/core/models/workspace.ts'
      export {
        makeTerminalContent, makeStickyNoteContent, makePortalContent,
        makeFileTreeContent, makeCodeEditorContent, makeDataTableContent,
        makeImageContent, makeWidgetContent, makeSecretVaultContent, makeTextContent
      } from './src/main/core/models/node-content.ts'
      export { makeWorkspaceEntry } from './src/main/core/models/app-state.ts'
      export { makeProject } from './src/main/core/models/project.ts'
      export { nowISO } from './src/main/core/coding.ts'
      export { QUICK_STARTS, ARTISAN_NAME, ARTISAN_ICON, ARTISAN_COLOR } from './src/shared/terminal-presets.ts'
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
const { paths, dataDir, defaultDataDir, persistence } = core
const { makeCanvasNode, makeConnection, makeNodeGroup, makeWorkspacePayload } = core
const { encodeWorkspaceDocument, decodeWorkspaceDocument } = core
const {
  makeTerminalContent, makeStickyNoteContent, makePortalContent,
  makeFileTreeContent, makeCodeEditorContent, makeDataTableContent,
  makeImageContent, makeWidgetContent, makeSecretVaultContent, makeTextContent
} = core
const { makeWorkspaceEntry, makeProject, nowISO } = core
const { QUICK_STARTS, ARTISAN_ICON, ARTISAN_COLOR } = core

const HOME = dataDir()
if (HOME === defaultDataDir() && !FORCE) {
  console.error(
    `recusado: isto gravaria dentro de ${HOME} — o ~/.atelier real, onde o app\n` +
    `do usuário está rodando agora. Aponte ATELIER_HOME para um diretório de\n` +
    `trabalho (ex: /tmp/demo-home) ou passe --force se for mesmo o que você quer.`
  )
  process.exit(1)
}

// ─── Idempotência: parte do zero ────────────────────────────────────────────
// Apaga a pasta inteira do workspace (workspace.json + satélites). Sem isto,
// cada run gera ids novos para cofre/tabela/imagem/quadro e os arquivos da run
// anterior ficariam órfãos em disco.
await persistence.deleteWorkspace(DEMO_WORKSPACE_ID)

// ─── Fontes de brinquedo (Fatia 1/2, já no repo) ─────────────────────────────
// POR QUE copiar o repo para fora em vez de apontar para o fixture: o índice de
// projetos do Atelier só reconhece diretório com `.git` (projects/detect.ts), e
// um `.git` dentro de `fixtures/` cairia no controle de versão do próprio
// Atelier. A cópia mora no ATELIER_HOME de trabalho, ganha `git init`, e é nela
// que os agentes roteirizados escrevem `src/search.ts` ao vivo. Todos os nós de
// execução (terminais, botão, árvore, editor) e o workingDirectory do workspace
// passam a apontar para `DEMO_REPO` — que agora É a cópia.
const DEMO_REPO_SRC = join(ROOT, 'fixtures/demo/repo')
const DEMO_REPO = join(HOME, 'demo-repo')
const DEMO_AGENT = join(ROOT, 'fixtures/demo/bin/demo-agent.mjs')

// ─── Fatia 5: prepara a cópia de trabalho do demo-repo ──────────────────────
// Recria do zero a cada run: a demo é idempotente de propósito e um `git init`
// em diretório limpo nunca esbarra num `.git` de uma geração anterior.
await rm(DEMO_REPO, { recursive: true, force: true })
await cp(DEMO_REPO_SRC, DEMO_REPO, { recursive: true })

// `git init` + commit inicial — sem `.git` o diretório não indexa. Se o git não
// existe na máquina ou o init falha, AVISA e segue: a árvore ainda aponta para
// a pasta (tabela de riscos do plano, linha "o `git init` do demo-repo falha").
let gitBranch = null
try {
  const git = (args) => execFileSync('git', args, { cwd: DEMO_REPO, stdio: 'pipe' })
  git(['init', '-q', '-b', 'main'])
  git(['add', '-A'])
  // `-c` no comando: a máquina da demo (ou o CI) pode não ter user.name/email
  // global, e um `commit.gpgsign` herdado quebraria o commit sem chave.
  git([
    '-c', 'user.name=Atelier Demo',
    '-c', 'user.email=demo@atelier.local',
    '-c', 'commit.gpgsign=false',
    'commit', '-q', '-m', 'chore: repo de brinquedo da demo (busca no CLI)'
  ])
  gitBranch = 'main'
} catch (err) {
  console.warn(
    `aviso: git init/commit falhou em ${DEMO_REPO}\n` +
    `       (${String(err.message).split('\n')[0]})\n` +
    `       a demo segue; a árvore aponta para a pasta, mas a aba Projetos só\n` +
    `       lista diretório com .git.`
  )
}

// Registra a cópia no projects.json, no formato que o codec do repo lê
// (models/project.ts via persistence.saveProjectIndex). Remove a entrada do
// mesmo caminho antes de inserir: rodar de novo atualiza, nunca duplica.
const projectIndex = await persistence.loadProjectIndex()
projectIndex.projects = projectIndex.projects.filter(
  (p) => resolve(p.path) !== resolve(DEMO_REPO)
)
projectIndex.projects.push(
  makeProject({
    path: DEMO_REPO,
    name: 'demo-repo',
    kind: 'node',
    language: 'javascript',
    gitBranch,
    gitRemote: null,
    summary:
      'Repo de brinquedo da demo do Atelier: o time implementa busca no CLI. ' +
      'Sem dependências, testável com `node --test`.',
    stack: ['TypeScript', 'Node.js'],
    lastCommitAt: null
  })
)
await persistence.saveProjectIndex(projectIndex)
const agentCmd = (script) => `node ${JSON.stringify(DEMO_AGENT)} --script ${script}`

const claudeQS = QUICK_STARTS.find((q) => q.id === 'claude')
const codexQS = QUICK_STARTS.find((q) => q.id === 'codex')

// ─── Fatia 4: dados dos satélites (criados por outro agente em fixtures/demo) ─
const DEMO_FIX = join(ROOT, 'fixtures/demo')
const specText = readFileSync(join(DEMO_FIX, 'spec.md'), 'utf8')
const buscas = JSON.parse(readFileSync(join(DEMO_FIX, 'buscas.json'), 'utf8'))
const arquiteturaPng = readFileSync(join(DEMO_FIX, 'arquitetura.png'))
const TODO_FIXTURE = join(DEMO_FIX, 'todo.json')
// Dimensões direto do IHDR do PNG (bytes 16..24) — não hardcode um 1200x320
// que a próxima troca do diagrama deixaria mentiroso.
const pngWidth = arquiteturaPng.readUInt32BE(16)
const pngHeight = arquiteturaPng.readUInt32BE(20)
// Nome do arquivo do quadro em todos/. É um UUID solto (sem extensão), como o
// `atelier todo create` gera; `paths.todoFile` acrescenta o `.json`.
const TODO_FILE = randomUUID()
const DEMO_NOW = nowISO()

// ─── O cofre: cifra DE VERDADE, ou nada ─────────────────────────────────────
// POR QUE não um mock: quem lê este `.vault` é o Atelier REAL, dentro do
// Electron, onde `persistence.readVault` chama `safeStorage.decryptString` do
// chaveiro do SO (DPAPI/libsecret/Keychain). Bytes de um `safeStorage` falso
// não são um blob do chaveiro — no palco o cofre não abriria e o momento 6 da
// demo quebraria —, e `base64 -d` num blob-mock devolve o segredo em claro,
// contra a promessa do nó. Então: ou ciframos com o chaveiro real, ou não
// gravamos `.vault` nenhum (cofre vazio e honesto > arquivo que o app recusa).
//
// A cifra real roda no Electron do próprio repo, num subprocesso curto — mesma
// técnica do `scripts/make-icon.cjs` (app.whenReady → trabalha → imprime → sai).
const vaultFile = {
  version: 1,
  kdf: null,
  entries: [
    {
      key: 'DEMO_API_KEY',
      value: 'demo-not-a-real-key',
      origin: null,
      inEnv: false,
      note: 'Chave falsa da demo — o agente lê sem exibir o valor.',
      updatedAt: DEMO_NOW,
      source: 'user'
    }
  ]
}
const vaultBlob = encryptWithElectronKeychain(JSON.stringify(vaultFile))
// keys[] do nó espelha o que ESTÁ no `.vault`: sem blob, o cofre nasce vazio.
const vaultKeys = vaultBlob
  ? [
      {
        key: 'DEMO_API_KEY',
        inEnv: false,
        origin: null,
        note: 'chave falsa da demo',
        updatedAt: DEMO_NOW,
        source: 'user'
      }
    ]
  : []

/**
 * Cifra `plaintext` com `safeStorage` do SO, num subprocesso Electron.
 * Devolve o base64 do blob, ou `null` no caminho degradado — Electron não
 * sobe (CI headless), ou `isEncryptionAvailable()` é false (sem libsecret).
 */
function encryptWithElectronKeychain(plaintext) {
  // O default export do pacote `electron`, importado do Node, é o caminho do
  // binário (o mesmo que o make-icon usa via require).
  let electronBinary
  try {
    electronBinary = createRequire(import.meta.url)('electron')
  } catch {
    return null
  }

  // Script efêmero no mesmo tmpdir do bundle. `.cjs` porque o Electron sobe
  // sem executar um `.mjs` de entrada (ver comentário do make-icon.cjs).
  const helper = join(outdir, 'vault-encrypt.cjs')
  writeFileSync(
    helper,
    `const { app, safeStorage } = require('electron')\n` +
      `app.disableHardwareAcceleration()\n` +
      `app.whenReady().then(() => {\n` +
      `  try {\n` +
      `    if (!safeStorage.isEncryptionAvailable()) { process.stdout.write('VAULT_UNAVAILABLE'); return app.exit(0) }\n` +
      `    const b64 = safeStorage.encryptString(process.env.DEMO_VAULT_PLAINTEXT).toString('base64')\n` +
      `    process.stdout.write('VAULT_B64:' + b64)\n` +
      `  } catch (e) {\n` +
      `    process.stdout.write('VAULT_ERR:' + (e && e.message))\n` +
      `  }\n` +
      `  app.exit(0)\n` +
      `})\n`
  )

  let out
  try {
    out = execFileSync(electronBinary, [helper], {
      encoding: 'utf8',
      timeout: 30_000,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, DEMO_VAULT_PLAINTEXT: plaintext }
    })
  } catch {
    return null
  }

  const line = String(out).trim()
  if (line.startsWith('VAULT_B64:')) return line.slice('VAULT_B64:'.length)
  return null
}

// ─── Os 14 nós (seção 2) ─────────────────────────────────────────────────────
// `frame` da seção 2 é [[x,y],[w,h]]; `makeCanvasNode` recebe {x,y,width,height}.
const node = ([[x, y], [width, height]], content) =>
  makeCanvasNode({ x, y, width, height }, content)

const n1 = node([[9600, 8180], [420, 44]], {
  type: 'text',
  value: { ...makeTextContent('Sprint: busca no CLI'), fontSize: 24, fontWeight: 'bold' }
})
const n2 = node([[9600, 8260], [280, 240]], {
  type: 'stickyNote',
  value: makeStickyNoteContent('Spec — busca')
})
const n3 = node([[9600, 8560], [540, 360]], {
  type: 'widget',
  // O título do QUADRO fica no `view` para o cabeçalho e o `atelier list` o
  // distinguirem — é por ele que o roteiro da Claude acha o board. `file` amarra
  // o nó ao JSON em `todos/<file>.json` (todo-store.ts:fileFor lê `view.file`).
  value: makeWidgetContent('todo', null, {
    title: 'Sprint da busca',
    file: TODO_FILE,
    mode: 'kanban'
  })
})
const n4 = node([[9600, 8980], [240, 200]], {
  type: 'secretVault',
  value: {
    ...makeSecretVaultContent('Credenciais'),
    // Espelho SEM valor da entrada do `.vault` (keyRefs em vault-manager.ts).
    // Vazio quando não houve cifra real — o nó não pode anunciar uma chave que
    // não está no arquivo.
    keys: vaultKeys
  }
})
const n5 = node([[10040, 8260], [480, 300]], {
  type: 'terminal',
  // O apresentador. `isArtisan: true` — delega abrindo nós, não subagentes.
  value: makeTerminalContent('Artesão', {
    agentType: 'claude_code',
    command: agentCmd('artesao'),
    workingDirectory: DEMO_REPO,
    icon: ARTISAN_ICON,
    color: ARTISAN_COLOR,
    isArtisan: true
  })
})
const n6 = node([[10040, 8600], [560, 360]], {
  type: 'terminal',
  // Recrutada pelo Artesão — não nasce Artesão.
  value: makeTerminalContent('Claude', {
    agentType: 'claude_code',
    command: agentCmd('implementa'),
    workingDirectory: DEMO_REPO,
    icon: claudeQS.icon,
    color: claudeQS.color
  })
})
const n7 = node([[10040, 9000], [560, 320]], {
  type: 'terminal',
  value: makeTerminalContent('Codex', {
    agentType: 'codex',
    command: agentCmd('revisa'),
    workingDirectory: DEMO_REPO,
    icon: codexQS.icon,
    color: codexQS.color
  })
})
const n8 = node([[10660, 8260], [150, 60]], {
  type: 'widget',
  // Widget não é conectável: o alvo (`npm test` no demo-repo) mora na config.
  value: makeWidgetContent('button', null, {
    label: 'npm test',
    icon: 'bolt',
    color: '#34C759',
    action: 'command',
    command: 'npm test',
    cwd: DEMO_REPO
  })
})
const n9 = node([[10680, 8400], [280, 360]], {
  type: 'fileTree',
  value: makeFileTreeContent('demo-repo', DEMO_REPO)
})
const n10 = node([[11000, 8400], [560, 400]], {
  type: 'codeEditor',
  value: makeCodeEditorContent(join(DEMO_REPO, 'src/search.ts'))
})
const n11 = node([[10680, 8800], [640, 420]], {
  type: 'portal',
  value: makePortalContent('Docs — demo-repo', 'http://localhost:4173')
})
const n12 = node([[11360, 8400], [420, 360]], {
  type: 'dataTable',
  // O resultado já materializado (fixtures/demo/buscas.json). `query` e `dialect`
  // ficam no NÓ, para a UI mostrar "de onde veio"; as linhas vão para
  // `tables/<fileName>.json` mais abaixo.
  value: (() => {
    const c = makeDataTableContent('buscas populares')
    c.query = buscas.query
    c.dialect = buscas.dialect
    c.rowCount = buscas.rows.length
    c.columnCount = buscas.columns.length
    c.truncated = buscas.truncated === true
    return c
  })()
})
const n13 = node([[11840, 8180], [300, 260]], {
  type: 'widget',
  value: makeWidgetContent('monitor')
})
const n14 = node([[11840, 8480], [360, 260]], {
  type: 'image',
  // Os bytes vão para `images/<fileName>` mais abaixo; aqui ficam as dimensões
  // (lidas do PNG) para o nó já reservar a proporção certa.
  value: makeImageContent('Arquitetura da busca', {
    alt: 'Diagrama da arquitetura da busca',
    naturalWidth: pngWidth,
    naturalHeight: pngHeight
  })
})

const nodes = [n1, n2, n3, n4, n5, n6, n7, n8, n9, n10, n11, n12, n13, n14]

// ─── Os 11 cabos (seção 2) ───────────────────────────────────────────────────
// Ordem canônica dos assimétricos: o terminal é sempre o lado A em
// note/portal/data; o cofre é o lado B em secret.
const connections = [
  makeConnection('terminal', n5.id, n6.id),   // C1  Artesão ⇄ Claude
  makeConnection('terminal', n5.id, n7.id),   // C2  Artesão ⇄ Codex
  makeConnection('terminal', n6.id, n7.id),   // C3  Claude ⇄ Codex (o momento-chave)
  makeConnection('note', n6.id, n2.id),       // C4  Spec ↔ Claude
  makeConnection('note', n7.id, n2.id),       // C5  Spec ↔ Codex
  makeConnection('data', n6.id, n3.id),       // C6  TODO ↔ Claude
  makeConnection('secret', n6.id, n4.id),     // C7  Credenciais ↔ Claude
  makeConnection('portal', n6.id, n11.id),    // C8  Docs ↔ Claude
  makeConnection('data', n5.id, n10.id),      // C9  Editor ↔ Artesão
  makeConnection('data', n5.id, n12.id),      // C10 Tabela ↔ Artesão
  makeConnection('data', n5.id, n14.id)       // C11 Imagem ↔ Artesão
]

// ─── Moldura da faixa de execução (seção 2) ──────────────────────────────────
const grupo = makeNodeGroup(
  'Execução',
  { x: 10000, y: 8180, width: 1400, height: 1180 },
  [n5.id, n6.id, n7.id, n9.id, n10.id, n11.id]
)

// ─── Monta e normaliza o payload ─────────────────────────────────────────────
const built = makeWorkspacePayload('Demo — busca no CLI', DEMO_REPO)
built.id = DEMO_WORKSPACE_ID
built.icon = 'sparkles'
built.nodes = nodes
built.connections = connections
built.groups = [grupo]

// decode(encode(x)) — o codec é idempotente; normalizar aqui é a garantia de
// que o arquivo em disco fecha o round-trip.
const payload = decodeWorkspaceDocument(encodeWorkspaceDocument(built)).payload

// ─── Escreve workspace.json (atômico, via o codec) ───────────────────────────
await persistence.saveWorkspace(payload)

// ─── Fatia 4: os satélites ──────────────────────────────────────────────────
// Cada arquivo vai para o caminho que o módulo que O LÊ espera — sem inventar
// formato. Os ids saem do payload JÁ normalizado (UUID em caixa alta), que é o
// que o app vai procurar em disco.
const pick = (fn) => payload.nodes.find(fn)
const noteNode = pick((n) => n.content.type === 'stickyNote')
const todoNode = pick((n) => n.content.type === 'widget' && n.content.value.kind === 'todo')
const vaultNode = pick((n) => n.content.type === 'secretVault')
const tableNode = pick((n) => n.content.type === 'dataTable')
const imageNode = pick((n) => n.content.type === 'image')

// (1) Nota — um `.md` de verdade em `notes/`, no nome que o StickyNoteContent
//     aponta (node-content.ts:uniqueNoteFileName). Mesmo caminho do
//     `atelier note write`.
await persistence.writeNote(DEMO_WORKSPACE_ID, noteNode.content.value.fileName, specText)

// (2) Quadro — `todos/<view.file>.json`, no formato que todo-store.ts:parseBoard
//     lê. O fixture já está nessa forma (version/title/columns/items); copio-o
//     tal e qual para o nome amarrado ao widget.
await cp(TODO_FIXTURE, paths.todoFile(DEMO_WORKSPACE_ID, todoNode.content.value.view.file))

// (3) Cofre — grava o blob cifrado PELO CHAVEIRO REAL (ver
//     `encryptWithElectronKeychain` acima) direto em `vaults/<id>.vault`, que é
//     texto base64, exatamente o que `persistence.readVault` lê e manda para
//     `safeStorage.decryptString`. NÃO passa por `persistence.writeVault`: essa
//     via cifra de novo, e este processo Node não tem `safeStorage`.
//     Caminho degradado: sem blob, nenhum `.vault` — o nó já nasceu com
//     `keys: []` e o aviso abaixo diz o que fazer.
if (vaultBlob) {
  await mkdir(paths.vaultsDir(DEMO_WORKSPACE_ID), { recursive: true })
  await writeFile(paths.vaultFile(DEMO_WORKSPACE_ID, vaultNode.content.value.id), vaultBlob, 'utf8')
}

// (4) Tabela — `tables/<fileName>.json` no formato DataTablePayload
//     ({ columns, rows, truncated }) que persistence.readTable devolve e o
//     handler `table append` compara. A query e o dialeto ficaram no nó.
await persistence.writeTable(DEMO_WORKSPACE_ID, tableNode.content.value.fileName, {
  columns: buscas.columns,
  rows: buscas.rows,
  truncated: buscas.truncated === true
})

// (5) Imagem — os bytes do PNG no arquivo gerenciado `images/<fileName>`, via
//     persistence.writeImage (mesmo caminho do `atelier image`).
await persistence.writeImage(DEMO_WORKSPACE_ID, imageNode.content.value.fileName, arquiteturaPng)

// ─── Registra no manifest.json e aponta o app-state.json ─────────────────────
const manifest = await persistence.loadManifest()
manifest.workspaces = manifest.workspaces.filter((w) => w.id !== DEMO_WORKSPACE_ID)
manifest.workspaces.push(
  makeWorkspaceEntry('Demo — busca no CLI', DEMO_REPO, DEMO_WORKSPACE_ID)
)
await persistence.saveManifest(manifest)

const appState = await persistence.loadAppState()
appState.activeWorkspaceId = DEMO_WORKSPACE_ID
appState.recentWorkspaceIds = [
  DEMO_WORKSPACE_ID,
  ...appState.recentWorkspaceIds.filter((id) => id !== DEMO_WORKSPACE_ID)
]
await persistence.saveAppState(appState)

// ─── Verificação: round-trip do codec no arquivo gerado ──────────────────────
const raw = JSON.parse(readFileSync(paths.workspaceFile(DEMO_WORKSPACE_ID), 'utf8'))
const reencoded = encodeWorkspaceDocument(decodeWorkspaceDocument(raw).payload)
assert.deepEqual(reencoded, raw, 'encode(decode(x)) != x — o arquivo não fecha o round-trip')

const back = decodeWorkspaceDocument(raw).payload
assert.equal(back.nodes.length, 14, `esperava 14 nós, achei ${back.nodes.length}`)
assert.equal(back.connections.length, 11, `esperava 11 cabos, achei ${back.connections.length}`)

await rm(outdir, { recursive: true, force: true })

if (!vaultBlob) {
  console.warn(
    `aviso: o cofre nasceu VAZIO — o chaveiro do SO não cifrou nesta máquina\n` +
    `       (Electron headless, ou safeStorage.isEncryptionAvailable() = false).\n` +
    `       Crie a chave UMA vez no próprio nó Credenciais, ou com\n` +
    `       'atelier vault set Credenciais DEMO_API_KEY demo-not-a-real-key'.`
  )
}

console.log(`workspace de demonstração gerado`)
console.log(`  ATELIER_HOME     ${HOME}`)
console.log(`  workspace.json   ${paths.workspaceFile(DEMO_WORKSPACE_ID)}`)
console.log(`  nós              ${back.nodes.length}`)
console.log(`  cabos            ${back.connections.length}`)
console.log(`  grupos           ${back.groups.length}`)
console.log(`  round-trip       encode(decode(x)) == x  ✓`)
console.log(`  ativo em app-state.json e registrado no manifest.json`)
console.log(`  demo-repo        ${DEMO_REPO}`)
console.log(`  git              ${gitBranch ? `branch ${gitBranch}, 1 commit` : 'indisponível — sem .git (aviso acima)'}`)
console.log(`  projects.json    ${paths.projects()}  (${projectIndex.projects.length} projeto(s))`)
console.log(`  satélites        nota '${noteNode.content.value.fileName}', quadro (${JSON.parse(readFileSync(TODO_FIXTURE, 'utf8')).items.length} cartões), cofre (${vaultBlob ? 'DEMO_API_KEY cifrada pelo chaveiro real' : 'VAZIO — ver aviso'}), tabela (${buscas.rows.length} linhas), imagem (${pngWidth}×${pngHeight})`)
