// Guarda o gerador do workspace de demonstração
// (scripts/make-demo-workspace.mjs, ver docs/2026-08-30-PLANO-workspace-de-demonstracao.md).
//
// A demo é a vitrine do produto, e ela quebra CALADA: um `schemaVersion` novo,
// um campo a mais num `make*`, um caminho de satélite renomeado — nada disso
// falha em teste nenhum, e a descoberta acontece no palco, com plateia.
//
// O que este teste faz é rodar o gerador de verdade, contra um `ATELIER_HOME`
// descartável, e conferir o que o app vai encontrar quando abrir:
//
//   1. o arquivo satisfaz `encode(decode(x)) == x` pelo codec DO REPO — a mesma
//      prova do test-codec, agora sobre um arquivo que ninguém escreveu à mão;
//   2. nenhum nó foi descartado na decodificação (nó descartado abre o
//      workspace em modo seguro, com o autosave desligado — ver migrations.ts);
//   3. o inventário do plano está lá: 14 nós, 11 cabos, 1 grupo;
//   4. os satélites existem nos caminhos que os leitores do app procuram;
//   5. rodar duas vezes é idempotente — a demo é regenerada antes de cada
//      sessão, e uma segunda passada não pode duplicar projeto nem cofre.
//
// O cofre é o único item com DOIS desfechos legítimos: com chaveiro, o `.vault`
// existe e não revela o valor; sem chaveiro (CI headless), ele não deve existir
// e o nó nasce sem chave. O teste aceita os dois e recusa o terceiro — um
// `.vault` que o Atelier não conseguiria abrir.

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { deepStrictEqual } from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as esbuild from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

let falhas = 0
const fail = (msg) => { console.error(`  ✗ ${msg}`); falhas++ }
const ok = (msg) => console.log(`  ✓ ${msg}`)
const check = (cond, msg) => (cond ? ok(msg) : fail(msg))

console.log('\ngerador do workspace de demonstração\n')

const home = await mkdtemp(join(tmpdir(), 'atelier-demo-test-'))
const rodar = () =>
  execFileSync(process.execPath, [join(root, 'scripts/make-demo-workspace.mjs')], {
    env: { ...process.env, ATELIER_HOME: home },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  })

let saida
try {
  saida = rodar()
  ok('o gerador roda contra um ATELIER_HOME descartável')
} catch (err) {
  fail(`o gerador falhou: ${err.stderr || err.message}`)
  process.exit(1)
}

// ─── o arquivo, lido pelo codec do repo ──────────────────────────────────────
// Mesmo caminho de bundle do gerador e do smoke: imports RELATIVOS num stdin
// com `resolveDir`, nunca um caminho absoluto interpolado (no Windows `C:\a`
// vira escape de string).
const outdir = await mkdtemp(join(tmpdir(), 'atelier-demo-codec-'))
const outfile = join(outdir, 'codec.mjs')
await esbuild.build({
  stdin: {
    contents: `export { encodeWorkspaceDocument, decodeWorkspaceDocument } from './src/main/core/models/workspace.ts'`,
    resolveDir: root,
    loader: 'ts'
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  external: ['electron', 'node-pty'],
  alias: { '@shared': join(root, 'src/shared') },
  outfile,
  logLevel: 'silent'
})
const { encodeWorkspaceDocument, decodeWorkspaceDocument } = await import(pathToFileURL(outfile).href)

const wsDir = join(home, 'workspaces')
const [wsId] = readdirSync(wsDir)
const wsFile = join(wsDir, wsId, 'workspace.json')
const documento = JSON.parse(readFileSync(wsFile, 'utf8'))
const { payload, schemaVersion, droppedNodes } = decodeWorkspaceDocument(documento)

try {
  deepStrictEqual(encodeWorkspaceDocument(payload), documento)
  ok(`encode(decode(x)) == x no arquivo gerado (schemaVersion ${schemaVersion})`)
} catch {
  fail('o arquivo gerado NÃO sobrevive ao round-trip do codec')
}
check(droppedNodes === 0, `nenhum nó descartado na decodificação (${droppedNodes})`)

// ─── o inventário do plano ───────────────────────────────────────────────────
// Em disco os cabos moram em SEIS arrays por tipo; em memória o codec os
// normaliza num único `connections[]` com `kind` (ver models/workspace.ts).
// Contamos o de memória — é a forma que o app enxerga.
const cabos = payload.connections.length
const porTipo = payload.connections.reduce((acc, c) => {
  acc[c.kind] = (acc[c.kind] ?? 0) + 1
  return acc
}, {})

check(payload.nodes.length === 14, `14 nós (${payload.nodes.length})`)
check(cabos === 11, `11 cabos (${cabos}: ${JSON.stringify(porTipo)})`)
check(payload.groups.length === 1, `1 grupo (${payload.groups.length})`)

const tipos = new Set(payload.nodes.map((n) => n.content.type))
for (const t of ['terminal', 'stickyNote', 'portal', 'fileTree', 'codeEditor', 'dataTable', 'image', 'widget', 'secretVault', 'text']) {
  if (!tipos.has(t)) fail(`o tipo de nó '${t}' sumiu do canvas da demo`)
}
if (tipos.size === 10) ok('os dez tipos de nó da demo estão no canvas')

const artesao = payload.nodes.find((n) => n.content.type === 'terminal' && n.content.value.isArtisan)
check(!!artesao, 'o terminal do apresentador nasce Artesão')

// ─── os satélites, nos caminhos que os leitores do app procuram ──────────────
const wsPath = join(wsDir, wsId)
const temArquivo = (sub) => existsSync(join(wsPath, sub)) && readdirSync(join(wsPath, sub)).length > 0
check(temArquivo('notes'), 'a nota existe como .md em notes/')
check(temArquivo('todos'), 'o quadro de Tarefas existe em todos/')
check(temArquivo('tables'), 'a tabela existe em tables/')
check(temArquivo('images'), 'a imagem existe em images/')
check(existsSync(join(home, 'manifest.json')), 'o workspace está registrado no manifest.json')
check(existsSync(join(home, 'app-state.json')), 'o app-state.json aponta para ele')
check(existsSync(join(home, 'projects.json')), 'o demo-repo entrou no índice de projetos')
check(existsSync(join(home, 'demo-repo', 'package.json')), 'o demo-repo foi copiado para o ATELIER_HOME')

// ─── o cofre: dois desfechos legítimos, um proibido ──────────────────────────
const vaultDir = join(wsPath, 'vaults')
const vaults = existsSync(vaultDir) ? readdirSync(vaultDir) : []
const cofre = payload.nodes.find((n) => n.content.type === 'secretVault')
if (vaults.length) {
  const bruto = readFileSync(join(vaultDir, vaults[0]), 'utf8')
  const claro = Buffer.from(bruto, 'base64').toString('utf8')
  check(!claro.includes('demo-not-a-real-key'), 'o .vault não revela o valor da chave')
  check(cofre.content.value.keys.length === 1, 'o cofre declara a chave da demo')
  check(cofre.content.value.keys.every((k) => k.inEnv === false), 'a chave não nasce injetada no ambiente')
} else {
  check(
    cofre.content.value.keys.length === 0,
    'sem chaveiro: o cofre nasce VAZIO em vez de com um .vault que o app não abre'
  )
}

// ─── idempotência: a demo é regenerada antes de cada sessão ──────────────────
rodar()
const projetos = JSON.parse(readFileSync(join(home, 'projects.json'), 'utf8')).projects
check(projetos.length === 1, `segunda passada não duplica projeto (${projetos.length})`)
check(readdirSync(wsDir).length === 1, 'segunda passada reusa o mesmo workspace')
const vaults2 = existsSync(vaultDir) ? readdirSync(vaultDir) : []
check(vaults2.length === vaults.length, 'segunda passada não duplica cofre')

await rm(home, { recursive: true, force: true })
await rm(outdir, { recursive: true, force: true })

if (falhas) { console.error(`\ntest-demo-workspace: ${falhas} falha(s)`); process.exit(1) }
console.log('test-demo-workspace: ok')
