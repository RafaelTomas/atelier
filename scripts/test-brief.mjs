/**
 * `atelier brief` — o inventário do canvas no boot, para todo nó (M1 do plano
 * de aderência, docs/2026-09-01-PLANO-aderencia-dos-agentes.md).
 *
 * Chama `routeCLI` direto, sem socket — mesmo padrão do test-editor: o
 * protocolo HTTP já é exercitado pelo smoke, e aqui o que interessa é a
 * decisão do handler.
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as esbuild from 'esbuild'

const ROOT = resolve(import.meta.dirname, '..')

// ATELIER_HOME antes de qualquer import do núcleo — mesma razão do
// test-editor e do test-artesao: sem isto o teste grava no ~/.atelier real.
const home = await mkdtemp(join(tmpdir(), 'atelier-brief-'))
process.env.ATELIER_HOME = home
process.env.NODE_ENV = 'development'

const outdir = await mkdtemp(join(tmpdir(), 'atelier-brief-core-'))
const outfile = join(outdir, 'core.mjs')
await esbuild.build({
  stdin: {
    contents: `
      export { appState } from './src/main/core/state/app-state.ts'
      export { routeCLI } from './src/main/core/interagent/cli-router.ts'
      export { makeCanvasNode } from './src/main/core/models/workspace.ts'
      export {
        withCodexInstructions,
        tomlSingleLine
      } from './src/main/core/terminal/codex-instructions.ts'
      export {
        makeTerminalContent,
        makeStickyNoteContent,
        makePortalContent,
        makeCodeEditorContent,
        makeDataTableContent,
        makeSecretVaultContent,
        makeImageContent,
        makeWidgetContent
      } from './src/main/core/models/node-content.ts'
      export { projectIndex } from './src/main/core/state/project-store.ts'
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
const {
  appState,
  routeCLI,
  makeCanvasNode,
  makeTerminalContent,
  makeStickyNoteContent,
  makePortalContent,
  makeCodeEditorContent,
  makeDataTableContent,
  makeSecretVaultContent,
  makeImageContent,
  makeWidgetContent,
  projectIndex,
  withCodexInstructions,
  tomlSingleLine
} = core

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

console.log('\nbrief: o inventário do canvas no boot\n')

await appState.loadOnLaunch()
const ws = appState.activeWorkspace

function node(pos, content) {
  const n = makeCanvasNode({ x: pos, y: 0, width: 200, height: 150 }, content)
  ws.addNode(n)
  return n
}

function wire(caller, ...targets) {
  for (const t of targets) ws.addConnection(caller.id, t.id)
}

// ─── Canvas vazio ───────────────────────────────────────────────────────────

await test('canvas vazio: o brief cabe em 6 linhas, e traz a regra do canvas', async () => {
  // Eram 3 até 01/09. As três linhas a mais são a regra do subagente, e elas
  // valem também aqui: um nó sem nada cabeado é justamente o que mais parece
  // convidar a resolver tudo sozinho por dentro. O teto continua existindo
  // porque o brief custa contexto em TODA sessão.
  const orphan = node(0, { type: 'terminal', value: makeTerminalContent('Sozinho') })
  const out = await routeCLI(['brief'], orphan.id)
  assert.ok(out.split('\n').length <= 6, `brief vazio cresceu: ${out.split('\n').length} linhas`)
  assert.match(out, /nothing wired to this node yet/)
  assert.match(out, /never an internal subagent/)
})

// ─── Um nó comum, com um pouco de tudo ─────────────────────────────────────

let caller
let editorFile
await test('brief de um nó comum: um grupo por linha, cada um com o verbo', async () => {
  caller = node(1000, { type: 'terminal', value: makeTerminalContent('Chamador') })
  const peer = node(1100, { type: 'terminal', value: makeTerminalContent('Ajudante') })
  const note = node(1200, { type: 'stickyNote', value: makeStickyNoteContent('Spec') })
  const portal = node(1300, { type: 'portal', value: makePortalContent('Docs', 'https://example.com') })
  editorFile = join(home, 'arquivo.ts')
  const editor = node(1400, { type: 'codeEditor', value: makeCodeEditorContent(editorFile) })
  const vault = node(1500, { type: 'secretVault', value: makeSecretVaultContent('Cofre') })
  const table = node(1600, { type: 'dataTable', value: makeDataTableContent('Vendas') })
  const board = node(1700, { type: 'widget', value: makeWidgetContent('todo', null, { title: 'Sprint' }) })

  wire(caller, peer, note, portal, editor, vault, table, board)

  const out = await routeCLI(['brief'], caller.id)

  assert.match(out, /Agents: Ajudante/)
  assert.match(out, /atelier ask "Name" "the task"/)
  assert.match(out, /Notes: Spec/)
  assert.match(out, /atelier note read "Name"/)
  assert.match(out, /Portals: Docs/)
  assert.match(out, /atelier portal read "Name"/)
  assert.match(out, new RegExp(editorFile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'o caminho absoluto do editor não saiu')
  assert.match(out, /atelier editor read "Name"/)
  assert.match(out, /Vaults: Cofre/)
  assert.match(out, /atelier vault list/)
  // A tabela mudou de forma: era `Tables: Vendas` (nomes numa linha), agora é uma
  // linha por tabela com o CAMINHO do JSON — o ponteiro é a entrega, e é por
  // isso que `atelier table` não tem verbo de leitura. Sem arquivo ainda, a
  // linha diz isso em vez de inventar um caminho.
  assert.match(out, /Tables:/)
  assert.match(out, /Vendas\s+\S*[/\\]tables[/\\]\S+\.json/, 'o caminho do JSON da tabela não saiu')
  assert.match(out, /atelier table list/)
  assert.match(out, /read the rows from that JSON yourself/)
  assert.match(out, /Boards: Sprint/)
  // O exemplo do quadro leva o NOME, e leva um verbo que não é `list`: `list` é o
  // único que aceita omitir o quadro, e a forma curta daqui era copiada para
  // `todo move`, onde ela é erro de uso. Ver o comentário em handlers/brief.ts.
  assert.match(out, /atelier todo list "Sprint"/)
  assert.match(out, /atelier todo move "Sprint" <id> doing/)
  assert.match(out, /every verb but list needs the board/)

  // Nenhum grupo vazio aparece — não há "(none)" nem grupo que não foi cabeado.
  assert.ok(!/\(none\)/.test(out), 'um grupo vazio vazou como "(none)"')
})

await test('com DOIS quadros o exemplo continua nomeando um deles', async () => {
  // Este é o caso que mordeu: dois quadros cabeados, e `todo move <id> doing`
  // sem o nome é erro de uso sem nada a que recorrer. O brief tem de sair com um
  // nome real em ambos os exemplos — o do primeiro quadro, que é copiável.
  const segundo = node(1750, { type: 'widget', value: makeWidgetContent('todo', null, { title: 'Rascunho' }) })
  wire(caller, segundo)

  const out = await routeCLI(['brief'], caller.id)

  assert.match(out, /Boards: Sprint, Rascunho/)
  assert.match(out, /atelier todo move "Sprint" <id> doing/)
  assert.ok(
    !/atelier todo (list|move) (?!")/.test(out),
    'saiu um exemplo de todo sem o nome do quadro'
  )
})

await test('teto de 30 linhas: um canvas típico não estoura', async () => {
  const out = await routeCLI(['brief'], caller.id)
  const n = out.split('\n').length
  assert.ok(n <= 30, `brief típico passou de 30 linhas: ${n}`)
})

await test('sem Artesão, o brief não traz a doutrina', async () => {
  const out = await routeCLI(['brief'], caller.id)
  assert.ok(!out.includes('You are an ARTISAN'), 'a doutrina vazou para um nó comum')
})

// ─── Artesão: a doutrina inteira como bloco ────────────────────────────────

await test('brief de um Artesão: o inventário some ANTES da doutrina inteira', async () => {
  const artisan = node(2000, {
    type: 'terminal',
    value: makeTerminalContent('Artesão', { isArtisan: true })
  })
  const helper = node(2100, { type: 'terminal', value: makeTerminalContent('Recrutado') })
  wire(artisan, helper)

  const out = await routeCLI(['brief'], artisan.id)

  // O inventário genérico continua na frente...
  assert.match(out, /Agents: Recrutado/)
  // ...e a doutrina inteira do Artesão vem depois, como bloco — não some, não
  // vira um resumo. As mesmas regras de `atelier artesao brief`.
  assert.match(out, /You are an ARTISAN on this Atelier canvas\./)
  assert.match(out, /Task\ntool is denied here/)
  assert.match(out, /Rules of the workshop:/)
  assert.match(out, /On this canvas right now:/)
  assert.match(out, /Already cabled to you: Recrutado/)

  const doctrineAt = out.indexOf('You are an ARTISAN on this Atelier canvas.')
  const inventoryAt = out.indexOf('Agents: Recrutado')
  assert.ok(inventoryAt < doctrineAt, 'a doutrina entrou ANTES do inventário')
})

await test('brief de um Artesão sozinho ainda traz a doutrina inteira', async () => {
  const alone = node(3000, {
    type: 'terminal',
    value: makeTerminalContent('Sozinho Artesão', { isArtisan: true })
  })
  const out = await routeCLI(['brief'], alone.id)
  assert.match(out, /nothing wired to this node yet/)
  assert.match(out, /You are an ARTISAN on this Atelier canvas\./)
  assert.match(out, /Nobody is cabled to you yet/)
})

// ─── O canal do Codex: o brief pelo argv ────────────────────────────────────

await test('o comando do Codex ganha o brief em developer_instructions', () => {
  const cx = node(4000, { type: 'terminal', value: makeTerminalContent('Codex') })
  const peer = node(4100, { type: 'terminal', value: makeTerminalContent('Vizinho') })
  wire(cx, peer)

  const out = withCodexInstructions('codex --model gpt-5.6-luna', cx.id, 'linux')

  // A flag vai no FIM, e o comando original fica intacto na frente: quem lê o
  // `argv` num `ps` continua vendo qual agente e qual modelo subiram.
  assert.ok(out.startsWith('codex --model gpt-5.6-luna '), `comando alterado: ${out}`)
  assert.match(out, /-c 'developer_instructions="/)
  // O inventário do canvas está lá dentro, e numa linha só.
  assert.match(out, /Agents: Vizinho/)
  assert.equal(out.split('\n').length, 1, 'o argumento saiu com newline literal')
  assert.match(out, /\\n/, 'os newlines do brief não viraram \\n escapado')
})

await test('quem não é Codex não ganha nada, e o Claude não é tocado', () => {
  const cx = node(4200, { type: 'terminal', value: makeTerminalContent('Outro') })
  for (const cmd of ['claude --model sonnet', 'npx codex', 'bash', 'agy', 'opencode', '']) {
    assert.equal(withCodexInstructions(cmd, cx.id, 'linux'), cmd, `mexeu em '${cmd}'`)
  }
})

await test('developer_instructions do usuário vence, e não é sobreposto', () => {
  // Mesma regra do `--settings` já escrito à mão: sobrepor em silêncio trocaria
  // a configuração que o usuário digitou.
  const cx = node(4300, { type: 'terminal', value: makeTerminalContent('Codex Manual') })
  const meu = `codex -c 'developer_instructions="o meu texto"'`
  assert.equal(withCodexInstructions(meu, cx.id, 'linux'), meu)
})

await test('no Windows o comando volta intacto, em vez de sair partido', () => {
  // A citação é POSIX e o valor é cheio de aspas duplas. As do cmd.exe e as do
  // PowerShell são outras, e nenhuma das duas foi medida: um brief que não
  // chega é melhor que um nó que não sobe.
  const cx = node(4400, { type: 'terminal', value: makeTerminalContent('Codex Win') })
  assert.equal(withCodexInstructions('codex', cx.id, 'win32'), 'codex')
  assert.notEqual(withCodexInstructions('codex', cx.id, 'linux'), 'codex')
})

await test('o escape TOML: barra primeiro, toda aspa, e nenhum controle cru', () => {
  // Isto é texto de USUÁRIO indireto: o brief carrega nomes de nós do canvas.
  assert.equal(tomlSingleLine('a\\b'), '"a\\\\b"')
  assert.equal(tomlSingleLine('atelier ask "Name"'), '"atelier ask \\"Name\\""')
  // Três aspas seguidas não precisam de regra própria porque TODA aspa já é
  // escapada — a regra por vizinhança é a que erra no caso que ninguém testou.
  assert.equal(tomlSingleLine('a "" " b'), '"a \\"\\" \\" b"')
  assert.equal(tomlSingleLine('um\ndois'), '"um\\ndois"')
  assert.equal(tomlSingleLine('um\tdois'), '"um\\tdois"')
  // CR sozinho: só é legal em TOML como metade de um CRLF, e um brief que
  // passou por editor do Windows tem CR sozinho.
  assert.equal(tomlSingleLine('a\rb'), '"a\\u000db"')
  assert.equal(tomlSingleLine('a\u001b[31m'), '"a\\u001b[31m"')
  assert.equal(tomlSingleLine('a\u0000b'), '"a\\u0000b"')
  // Nenhum controle cru sobrou dentro das aspas.
  const cru = tomlSingleLine('x\u0001\u0002\u001f\u007fy')
  assert.ok(
    !/[\u0000-\u0008\u000b-\u001f\u007f]/.test(cru),
    `controle cru sobrou: ${JSON.stringify(cru)}`
  )
})

await test('a barra é escapada ANTES das aspas, e não escapa as nossas', () => {
  // Se a ordem invertesse, a barra que introduzimos para a aspa viraria barra
  // dupla e a aspa voltaria a fechar a string — o brief inteiro cairia para
  // literal cru, numa linha só e com as barras à mostra.
  assert.equal(tomlSingleLine('C:\\dir\\ "x"'), '"C:\\\\dir\\\\ \\"x\\""')
})

await test('o brief do argv é o MESMO texto que o CLI devolve', () => {
  // Se divergirem, um nó Codex e um nó Claude no mesmo lugar do canvas passam a
  // ter inventários diferentes, e nada avisa.
  const cx = node(4500, { type: 'terminal', value: makeTerminalContent('Codex Igual') })
  const nota = node(4600, { type: 'stickyNote', value: makeStickyNoteContent('Recado') })
  wire(cx, nota)
  const out = withCodexInstructions('codex', cx.id, 'linux')
  assert.match(out, /Notes: Recado/)
  assert.match(out, /atelier note read/)
})

await rm(outdir, { recursive: true, force: true })
await rm(home, { recursive: true, force: true })


// ─── Todo tipo aparece, e o teto continua de pé ─────────────────────────────
//
// A afirmação central do plano de 08/09: um nó que não aparece no inventário
// não existe para o agente. Sete tipos não apareciam — árvore, imagem, painel
// de git, de monitor, de projetos, botão e título —, e a correção é justamente
// a que arrisca estourar o teto de linhas deste arquivo. Os dois casos abaixo
// andam juntos de propósito: um exige que tudo apareça, o outro que a resposta
// continue caber.

let cheioCaller
let cheioOut
await test('todo tipo de nó cabeado aparece no brief', async () => {
  cheioCaller = node(3000, { type: 'terminal', value: makeTerminalContent('Cheio') })
  const arvore = node(3100, { type: 'fileTree', value: { name: 'Projeto', rootPath: home, viewMode: 'list' } })
  const imagem = node(3200, { type: 'image', value: makeImageContent('Gráfico', { mimeType: 'image/png' }) })
  const git = node(3300, { type: 'widget', value: makeWidgetContent('git', null, {}) })
  const monitor = node(3400, { type: 'widget', value: makeWidgetContent('monitor', null, { disk: '/', interval: '2000' }) })
  const projetos = node(3500, { type: 'widget', value: makeWidgetContent('projects', null, {}) })
  const botao = node(3600, { type: 'widget', value: makeWidgetContent('button', null, { label: 'Testes', action: 'command', command: 'npm test' }) })
  const relogio = node(3700, { type: 'widget', value: makeWidgetContent('clock', null, { mode: 'stopwatch' }) })
  const titulo = node(3800, { type: 'text', value: { text: 'Fluxo de deploy', fontSize: 18, fontWeight: 'regular', color: '#000', alignment: 'left', fontFamily: 'sans' } })

  wire(cheioCaller, arvore, imagem, git, monitor, projetos, botao, relogio, titulo)
  cheioOut = await routeCLI(['brief'], cheioCaller.id)

  // A árvore leva o CAMINHO — o requisito inteiro dela, e o que ela não tinha
  // como entregar enquanto não aceitava cabo.
  assert.match(cheioOut, /Trees:/)
  assert.match(cheioOut, new RegExp(home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'a raiz da árvore não saiu')

  // A imagem leva o caminho do arquivo gerenciado, para o agente abrir sozinho.
  assert.match(cheioOut, /Images:/)
  assert.match(cheioOut, /Gráfico\s+\S*[/\\]images[/\\]\S+/, 'o caminho do arquivo da imagem não saiu')

  // Os painéis: uma linha cada, com a referência resolvida. O de git sem
  // projeto selecionado DIZ isso, em vez de calar ou de supor um repo.
  assert.match(cheioOut, /Panels:/)
  assert.match(cheioOut, /no project selected/)
  assert.match(cheioOut, /volume \//)

  assert.match(cheioOut, /Buttons & clocks:/)
  assert.match(cheioOut, /Testes\s+\[command\]/)
  assert.match(cheioOut, /stopwatch/)

  assert.match(cheioOut, /Text:/)
  assert.match(cheioOut, /Fluxo de deploy/)

  // A frase que diz ao agente o que fazer com um ponteiro — é ela que evita a
  // pergunta seguinte ("e como eu leio isso?").
  assert.match(cheioOut, /pointer, not their content/)
})

await test('nove nós de tipos diferentes ainda cabem no teto do brief', async () => {
  // O teto é requisito, não estilo: o brief entra no contexto de TODA sessão.
  // Sete grupos novos em forma de bloco-com-verbo dobrariam a resposta; a forma
  // escolhida é uma linha por nó mais UMA frase para o conjunto.
  const linhas = cheioOut.split('\n').length
  assert.ok(linhas <= 30, `o brief de um canvas cheio estourou o teto: ${linhas} linhas`)
})

// ─── A referência do painel de git, resolvida ───────────────────────────────

await test('painel de git FIXADO num projeto diz o caminho e o branch', async () => {
  const projeto = await projectIndex.add({ path: home, name: 'lab' })
  const caller2 = node(4000, { type: 'terminal', value: makeTerminalContent('Git') })
  const git = node(4100, { type: 'widget', value: makeWidgetContent('git', projeto.id, {}) })
  wire(caller2, git)

  const out = await routeCLI(['brief'], caller2.id)
  assert.match(out, new RegExp(home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'o caminho do repo não saiu')
  assert.match(out, /\[pinned\]/, 'não disse que o painel está fixado, e não seguindo a seleção')
})

console.log(`\n${passed} passaram, ${failed} falharam\n`)
process.exit(failed > 0 ? 1 : 0)
