/**
 * `atelier node` — o verbo que monta canvas, e as recusas que o mantêm honesto.
 *
 * Três coisas aqui não são conveniência:
 *
 *   1. **Uma porta por quarto.** Todo tipo que já nasce por outro verbo tem de
 *      ser RECUSADO com o verbo certo no texto. Se `node create note` criasse
 *      uma nota, ela nasceria sem o `.md` que `note create` grava — um nó que
 *      parece certo no canvas e não tem conteúdo em disco.
 *   2. **A árvore não alarga o alcance do canvas.** `allowedRoots()` inclui as
 *      raízes das árvores do canvas, então uma árvore criada em `/` passaria a
 *      autorizar `editor open` em qualquer arquivo da máquina. A recusa fora da
 *      allowlist é a trava, e é o teste mais importante deste arquivo.
 *   3. **Tipo sem cabo diz que não tem cabo.** `text` e `fileTree` nunca
 *      aparecem em `atelier list`. Uma resposta que só diz "criado" faz o
 *      agente procurar o nó numa lista que jamais vai mostrá-lo.
 *
 * Chama `routeCLI` direto, sem socket, no mesmo molde do test-editor: o
 * protocolo HTTP já é exercitado pelo smoke, e aqui interessa a decisão.
 *
 * Uso: node scripts/test-node.mjs
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as esbuild from 'esbuild'

const ROOT = resolve(import.meta.dirname, '..')

// ATELIER_HOME antes de qualquer import do núcleo — mesmo motivo do test-editor:
// um teste que grava no diretório real apaga o canvas do usuário.
const home = await mkdtemp(join(tmpdir(), 'atelier-node-'))
process.env.ATELIER_HOME = home
process.env.NODE_ENV = 'development'

const outdir = await mkdtemp(join(tmpdir(), 'atelier-node-core-'))
const outfile = join(outdir, 'core.mjs')
await esbuild.build({
  stdin: {
    contents: `
      export { appState } from './src/main/core/state/app-state.ts'
      export { routeCLI } from './src/main/core/interagent/cli-router.ts'
      export { makeCanvasNode } from './src/main/core/models/workspace.ts'
      export { makeTerminalContent } from './src/main/core/models/node-content.ts'
      export { boundsForNodes } from './src/shared/group-geometry.ts'
      export { firstFreeSpot } from './src/main/core/spawn-spot.ts'
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

const {
  appState,
  routeCLI,
  makeCanvasNode,
  makeTerminalContent,
  boundsForNodes,
  firstFreeSpot
} = await import(pathToFileURL(outfile).href)

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

console.log('\n`atelier node`: criar nós e emoldurar\n')

// ─── A busca de lugar vazio (spawn-spot.ts), pura ────────────────────────────

const r = (x, y, width, height) => ({ x, y, width, height })
const SIZE = { width: 100, height: 100 }

await test('canvas vazio: o ponto preferido é o próprio', () => {
  assert.deepEqual(firstFreeSpot([], { x: 500, y: 500 }, SIZE), { x: 500, y: 500 })
})

await test('ponto ocupado desvia AO LADO, na mesma fileira — não na diagonal', () => {
  // A ordem de leitura é decisão de produto: o nó novo tem de aparecer ao lado,
  // não acima nem atrás. Varrendo o anel de cima para baixo, como era antes,
  // o primeiro livre era a quina SUPERIOR e o nó subia.
  const at = firstFreeSpot([r(500, 500, 100, 100)], { x: 500, y: 500 }, SIZE)
  assert.equal(at.y, 500, `saiu da fileira: ${at.x},${at.y}`)
  assert.ok(at.x >= 600, `sobrepõe o vizinho: ${at.x},${at.y}`)
})

await test('nunca devolve ponto que colide — 200 nós numa grade apertada', () => {
  // O caso que a cascata antiga errava: área densa. Aqui a malha inteira ao
  // redor do preferido está tomada, e a busca tem de sair do bloco.
  const taken = []
  for (let i = 0; i < 20; i++) {
    for (let j = 0; j < 10; j++) taken.push(r(500 + i * 100, 500 + j * 100, 100, 100))
  }
  const at = firstFreeSpot(taken, { x: 500, y: 500 }, SIZE)
  assert.ok(at, 'não achou vaga num raio de 1600px')
  const colide = taken.some(
    (t) =>
      at.x < t.x + t.width &&
      at.x + SIZE.width > t.x &&
      at.y < t.y + t.height &&
      at.y + SIZE.height > t.y
  )
  assert.equal(colide, false, `devolveu (${at.x},${at.y}), que colide`)
})

await test('a vaga sai PERTO, não a 1600px — um vazio distante é inútil', () => {
  const taken = [r(500, 500, 100, 100)]
  const at = firstFreeSpot(taken, { x: 500, y: 500 }, SIZE)
  const dist = Math.max(Math.abs(at.x - 500), Math.abs(at.y - 500))
  assert.ok(dist <= 120, `caiu a ${dist}px do ponto pedido`)
})

await appState.loadOnLaunch()
const ws = appState.activeWorkspace

// A allowlist da árvore sai daqui, igual à do editor: o diretório de trabalho
// do workspace é uma das raízes permitidas (core/projects/allowed-roots.ts).
const lab = await realpath(await mkdtemp(join(tmpdir(), 'atelier-node-lab-')))
await mkdir(join(lab, 'sub'), { recursive: true })
ws.payload.workingDirectory = lab

const FORA = await realpath(await mkdtemp(join(tmpdir(), 'atelier-node-fora-')))

const terminal = makeCanvasNode(
  { x: 100, y: 100, width: 560, height: 360 },
  { type: 'terminal', value: makeTerminalContent('Artesão') }
)
ws.addNode(terminal)
const tid = terminal.id

const cli = (...args) => routeCLI(args, tid)
const nodesOfType = (type) => ws.nodes.filter((n) => n.content.type === type)
const groupTitleOf = (id) => ws.payload.groups.find((g) => g.nodeIds.includes(id))?.title ?? null

// ─── Uma porta por quarto ────────────────────────────────────────────────────

await test('sem subcomando, o usage traz os quatro modos', async () => {
  const out = await cli('node')
  assert.match(out, /node create text/)
  assert.match(out, /node create fileTree/)
  assert.match(out, /node create widget/)
  assert.match(out, /node group/)
})

for (const [tipo, verbo] of [
  ['note', 'atelier note create'],
  ['stickyNote', 'atelier note create'],
  ['terminal', 'atelier recruit'],
  ['portal', 'atelier portal open'],
  ['codeEditor', 'atelier editor open'],
  ['dataTable', 'atelier table create'],
  ['image', 'atelier image create'],
  ['secretVault', 'atelier vault set']
]) {
  await test(`create ${tipo} recusa apontando \`${verbo}\` e não cria nada`, async () => {
    const antes = ws.nodes.length
    const out = await cli('node', 'create', tipo)
    assert.match(out, /^error:/)
    assert.ok(out.includes(verbo), `a recusa não ensina o verbo certo: ${out}`)
    assert.equal(ws.nodes.length, antes, 'criou nó apesar da recusa')
  })
}

await test('widget todo e widget button caem nos verbos próprios deles', async () => {
  const antes = ws.nodes.length
  const todo = await cli('node', 'create', 'widget', 'todo')
  assert.match(todo, /atelier todo create/)
  const button = await cli('node', 'create', 'widget', 'button')
  assert.match(button, /atelier button propose/)
  assert.equal(ws.nodes.length, antes)
})

await test('kind desconhecido lista os que existem, em vez de criar um vazio', async () => {
  const out = await cli('node', 'create', 'widget', 'kanbanzinho')
  assert.match(out, /^error:/)
  // Os três PAINÉIS, e só eles: quadro, botão e relógio saíram desta lista
  // quando cada um ganhou verbo próprio (KIND_OWNED_ELSEWHERE em handlers/node).
  assert.match(out, /projects, git, monitor/)
})

await test('kind com verbo próprio aponta o verbo, em vez de criar por aqui', async () => {
  // Duas gramáticas para o mesmo nó envelheceriam separadas, e no caso do
  // relógio a segunda porta pularia a autorização do alarme (nasce desarmado).
  for (const [kind, verbo] of [
    ['clock', /atelier clock create/],
    ['button', /atelier button propose/],
    ['todo', /atelier todo create/]
  ]) {
    const out = await cli('node', 'create', 'widget', kind)
    assert.match(out, /created by its own verb/, `'${kind}' não apontou o verbo`)
    assert.match(out, verbo)
  }
})

await test('tipo desconhecido recusa com o usage', async () => {
  const out = await cli('node', 'create', 'holograma')
  assert.match(out, /unknown node type 'holograma'/)
  assert.match(out, /node create text/)
})

// ─── text: nasce sem cabo, e a resposta diz isso ─────────────────────────────

await test('create text nasce CABEADO — todo nó cabeia', async () => {
  const out = await cli('node', 'create', 'text', 'Sprint 42 · nomes do DW')
  assert.match(out, /Created text/)
  assert.match(out, /connected to this terminal/)

  const texto = nodesOfType('text')
  assert.equal(texto.length, 1)
  assert.equal(texto[0].content.value.text, 'Sprint 42 · nomes do DW')
  assert.ok(ws.connectedNodeIds(tid).includes(texto[0].id), 'o título nasceu sem cabo')
})

await test('dois nós seguidos não nascem empilhados', async () => {
  await cli('node', 'create', 'text', 'Segundo título')
  const [a, b] = nodesOfType('text')
  assert.ok(
    a.frame.x !== b.frame.x || a.frame.y !== b.frame.y,
    'o segundo nó nasceu debaixo do primeiro'
  )
})

await test('nem o décimo — a cascata acaba, e o plano B não pode empilhar', async () => {
  // O caso que passou batido: a cascata do spawn-spot tem 12 tentativas e a 13ª
  // era a diagonal seguinte, devolvida SEM testar sobreposição. Com o canvas
  // povoado, todo nó criado depois disso caía no mesmo ponto — invisível
  // debaixo do anterior. Dois nós não bastavam para expor; dez bastam.
  for (let i = 0; i < 10; i++) await cli('node', 'create', 'text', `enchendo ${i}`)

  const sobrepoe = (a, b) =>
    a.frame.x < b.frame.x + b.frame.width &&
    a.frame.x + a.frame.width > b.frame.x &&
    a.frame.y < b.frame.y + b.frame.height &&
    a.frame.y + a.frame.height > b.frame.y

  for (let i = 0; i < ws.nodes.length; i++) {
    for (let j = i + 1; j < ws.nodes.length; j++) {
      assert.equal(
        sobrepoe(ws.nodes[i], ws.nodes[j]),
        false,
        `nó ${i} nasceu em cima do nó ${j}`
      )
    }
  }
})

// ─── fileTree: a trava de alcance ────────────────────────────────────────────

await test('árvore fora da allowlist recusa, e NÃO cria nó', async () => {
  const antes = ws.nodes.length
  const out = await cli('node', 'create', 'fileTree', FORA)
  assert.match(out, /^error:/)
  assert.match(out, /outside the paths this canvas may open/)
  assert.match(out, /index the project/)
  assert.equal(ws.nodes.length, antes, 'criou a árvore apesar da recusa')
})

await test('caminho inexistente responde "no such path"', async () => {
  const out = await cli('node', 'create', 'fileTree', join(lab, 'nao-existe'))
  assert.match(out, /no such path/)
})

await test('árvore dentro da allowlist nasce, com o rótulo do --name', async () => {
  const out = await cli('node', 'create', 'fileTree', lab, '--name', 'portal-fcxlabs')
  assert.match(out, /Created fileTree 'portal-fcxlabs'/)
  const arvores = nodesOfType('fileTree')
  assert.equal(arvores.length, 1)
  assert.equal(arvores[0].content.value.rootPath, lab)
  assert.equal(arvores[0].content.value.name, 'portal-fcxlabs')
})

await test('mesma raiz duas vezes devolve a existente, não um segundo nó', async () => {
  const out = await cli('node', 'create', 'fileTree', lab)
  assert.match(out, /already shows/)
  assert.equal(nodesOfType('fileTree').length, 1)
})

// ─── widget: painel cabeado ──────────────────────────────────────────────────

await test('painel de git nasce CABEADO — widget aceita cabo `data`', async () => {
  const out = await cli('node', 'create', 'widget', 'git')
  assert.match(out, /connected to this terminal/)
  const git = nodesOfType('widget').find((n) => n.content.value.kind === 'git')
  assert.ok(git, 'o painel de git não foi criado')
  assert.ok(ws.connectedNodeIds(tid).includes(git.id), 'o painel nasceu sem cabo')
})

await test('painel de projetos nasce seguindo a seleção global (projectId null)', async () => {
  await cli('node', 'create', 'widget', 'projects')
  const projetos = nodesOfType('widget').find((n) => n.content.value.kind === 'projects')
  assert.ok(projetos)
  assert.equal(projetos.content.value.projectId, null)
})

await test('painel singleton pedido duas vezes devolve o existente, não um segundo', async () => {
  // Os três leem estado global: dois nós mostram a mesma coisa. Um agente que
  // monta um canvas pede `git` sem saber que o usuário já tem um — e o canvas
  // acabava com dois painéis idênticos, que foi o que aconteceu de verdade.
  const antes = nodesOfType('widget').filter((n) => n.content.value.kind === 'git').length
  assert.equal(antes, 1)
  const out = await cli('node', 'create', 'widget', 'git')
  assert.match(out, /already on this canvas/)
  assert.equal(nodesOfType('widget').filter((n) => n.content.value.kind === 'git').length, 1)
})

await test('dois relógios são dois timers — clock NÃO é singleton', async () => {
  // O caso valia por `node create widget clock`, caminho que deixou de existir
  // quando o relógio ganhou verbo próprio. A afirmação continua valendo e é o
  // que importa: dois relógios são dois cronômetros, ao contrário dos painéis,
  // que leem estado global e por isso são singleton.
  await cli('clock', 'create', 'Primeiro', '--timer', '25m')
  await cli('clock', 'create', 'Segundo', '--timer', '5m')
  assert.equal(nodesOfType('widget').filter((n) => n.content.value.kind === 'clock').length, 2)
})

// ─── group: a moldura ────────────────────────────────────────────────────────

await test('group sem membros recusa com o usage', async () => {
  const out = await cli('node', 'group', 'G1 · Desenvolvimento')
  assert.match(out, /^error: usage/)
  assert.equal(ws.payload.groups.length, 0)
})

await test('membro inexistente recusa, e NÃO cria a moldura pela metade', async () => {
  const out = await cli('node', 'group', 'G1', 'Artesão', 'Fantasma')
  assert.match(out, /not found: 'Fantasma'/)
  assert.equal(ws.payload.groups.length, 0, 'criou grupo com parte dos membros')
})

await test('group alcança o próprio terminal, um painel cabeado e um `text` sem cabo', async () => {
  const out = await cli(
    'node',
    'group',
    'G1 · Desenvolvimento',
    'Artesão',
    'Git',
    'Sprint 42',
    '--color',
    '#0A84FF'
  )
  assert.match(out, /Created group 'G1 · Desenvolvimento' around 3 node\(s\)/)

  assert.equal(ws.payload.groups.length, 1)
  const g = ws.payload.groups[0]
  assert.equal(g.color, '#0A84FF')
  assert.equal(g.nodeIds.length, 3)
  assert.ok(g.nodeIds.includes(tid), 'o terminal que pediu ficou fora da moldura')

  const membros = g.nodeIds.map((id) => ws.node(id).frame)
  assert.deepEqual(g.frame, boundsForNodes(membros), 'o frame não é o bounds dos membros')
})

await test('um nó pertence a no máximo um grupo — o segundo o rouba do primeiro', async () => {
  const out = await cli('node', 'group', 'G2 · QA', 'Git')
  assert.match(out, /Created group 'G2 · QA'/)
  const [g1, g2] = ws.payload.groups
  const git = nodesOfType('widget').find((n) => n.content.value.kind === 'git')
  assert.equal(g1.nodeIds.includes(git.id), false, 'o nó ficou nos dois grupos')
  assert.ok(g2.nodeIds.includes(git.id))
})

// ─── `--at` e `node map` ─────────────────────────────────────────────────────

await test('--at coloca exatamente onde foi pedido', async () => {
  const out = await cli('node', 'create', 'text', 'posto à mão', '--at', '30000,30000')
  assert.match(out, /at \(30000,30000\)/)
  const posto = nodesOfType('text').find((n) => n.content.value.text === 'posto à mão')
  assert.equal(posto.frame.x, 30000)
  assert.equal(posto.frame.y, 30000)
})

await test('--at em lugar OCUPADO recusa, e diz quem está lá', async () => {
  // Sem esta recusa, `--at` seria a porta de trás que devolve o empilhamento
  // que todo o resto deste caminho existe para impedir.
  const antes = ws.nodes.length
  const out = await cli('node', 'create', 'text', 'em cima', '--at', '30000,30000')
  assert.match(out, /^error:/)
  assert.match(out, /is taken by 'posto à mão'/)
  assert.match(out, /node map/)
  assert.equal(ws.nodes.length, antes, 'criou o nó apesar da recusa')
})

await test('--at torto recusa em vez de virar NaN no frame', async () => {
  const out = await cli('node', 'create', 'text', 'x', '--at', 'meio,do,canvas')
  assert.match(out, /--at takes two numbers/)
})

await test('map lista tipo, tamanho e posição de TODO nó, de cima para baixo', async () => {
  const out = await cli('node', 'map')
  assert.match(out, /node\(s\) on this canvas/)
  for (const n of ws.nodes) assert.ok(out.includes(n.id.slice(0, 8)), `${n.id} ficou fora do map`)

  // Só as linhas de NÓ: as de grupo vêm depois e têm ordem própria.
  const ys = out
    .split('\n')
    .map((l) => l.match(/^ {2}[0-9A-F]{8} .* at \((-?\d+),(-?\d+)\)/i))
    .filter(Boolean)
    .map((m) => Number(m[2]))
  assert.ok(ys.length >= 5, `só extraí ${ys.length} linhas de nó do map`)
  assert.deepEqual(ys, [...ys].sort((a, b) => a - b), 'o map não saiu de cima para baixo')
})

await test('map AVISA sobreposição, com os dois ids e o verbo que corrige', async () => {
  // A informação já estava na lista de coordenadas e ninguém a extraía de
  // cabeça: catorze nós, e achar dois retângulos que se cruzam é conta. As duas
  // primeiras sobreposições reais deste projeto foram descobertas por uma FOTO
  // do canvas — que precisa de permissão, enquanto isto não precisa de nada.
  const a = makeCanvasNode(
    { x: 800000, y: 800000, width: 200, height: 100 },
    { type: 'text', value: { text: 'de baixo', fontSize: 18, fontWeight: 'regular', color: '#111', alignment: 'left', fontFamily: 'sans', isItalic: false, isUnderlined: false, isStrikethrough: false, backgroundColor: null, lineHeight: 1.3, letterSpacing: 0 } }
  )
  const b = makeCanvasNode(
    { x: 800050, y: 800050, width: 200, height: 100 },
    { type: 'text', value: { text: 'de cima', fontSize: 18, fontWeight: 'regular', color: '#111', alignment: 'left', fontFamily: 'sans', isItalic: false, isUnderlined: false, isStrikethrough: false, backgroundColor: null, lineHeight: 1.3, letterSpacing: 0 } }
  )
  ws.addNode(a)
  ws.addNode(b)

  const out = await cli('node', 'map')
  assert.match(out, /overlap\(s\) — one node is hidden under another/)
  const linha = out.split('\n').find((l) => l.includes(a.id.slice(0, 8)) && l.includes('under/over'))
  assert.ok(linha, 'o par sobreposto não saiu na lista de avisos')
  assert.ok(linha.includes(b.id.slice(0, 8)), 'o aviso não nomeia o outro lado do par')
  assert.match(out, /node move/)

  // E some quando o nó sai de cima: o aviso é estado, não histórico.
  await cli('node', 'move', b.id.slice(0, 8), '900000,900000')
  const depois = await cli('node', 'map')
  assert.equal(
    depois.split('\n').some((l) => l.includes('under/over') && l.includes(a.id.slice(0, 8))),
    false,
    'o aviso sobreviveu à correção'
  )
})

await test('map dá NOME do que é cabeado e esconde o do que não é', async () => {
  // Geometria é o que evita empilhar e não conta nada de ninguém. O nome de uma
  // nota que o usuário não cabeou a este terminal, sim.
  const solta = makeCanvasNode(
    { x: 90000, y: 90000, width: 260, height: 150 },
    { type: 'stickyNote', value: { color: '#fff', fileName: 'Segredos do cliente.md', fontSize: 14, hasCustomName: false, isPreviewing: false, storageMode: { kind: 'managed' }, textColor: null, fontFamily: 'mono', alignment: 'left' } }
  )
  ws.addNode(solta)

  const out = await cli('node', 'map')
  assert.ok(out.includes(solta.id.slice(0, 8)), 'a nota solta ficou fora do map')
  assert.equal(out.includes('Segredos do cliente'), false, 'vazou o nome de um nó não cabeado')
  assert.match(out, /at \(90000,90000\)/)
  assert.match(out, /Artesão/, 'escondeu o nome do próprio terminal, que é cabeado')
})

await test('map mostra a moldura e quantos membros ela tem', async () => {
  const out = await cli('node', 'map')
  assert.match(out, /group 'G1 · Desenvolvimento' at \(-?\d+,-?\d+\)/)
  assert.match(out, /member\(s\)/)
})

// ─── `node move`: endireitar o que já está lá ────────────────────────────────

await test('move leva o nó para o ponto pedido', async () => {
  const alvo = nodesOfType('fileTree')[0]
  const out = await cli('node', 'move', 'portal-fcxlabs', '70000,70000')
  assert.match(out, /Moved 'portal-fcxlabs' to \(70000,70000\)/)
  assert.equal(ws.node(alvo.id).frame.x, 70000)
  assert.equal(ws.node(alvo.id).frame.y, 70000)
})

await test('move para destino OCUPADO recusa, e não mexe no nó', async () => {
  // Mover para cima de alguém é o mesmo dano que criar em cima — a recusa é a
  // mesma do `--at`, com o mesmo texto de quem está no caminho.
  const alvo = nodesOfType('fileTree')[0]
  const antes = { ...alvo.frame }
  const out = await cli('node', 'move', 'portal-fcxlabs', '100,100')
  assert.match(out, /^error:/)
  assert.match(out, /is taken by 'Artesão'/)
  assert.deepEqual(
    { x: ws.node(alvo.id).frame.x, y: ws.node(alvo.id).frame.y },
    { x: antes.x, y: antes.y },
    'moveu apesar da recusa'
  )
})

await test('move não confunde o próprio nó com um obstáculo', async () => {
  // Um nó "colide" com o lugar onde ele já está. Sem excluir o próprio, mover
  // 40px para o lado seria sempre recusado.
  const alvo = nodesOfType('fileTree')[0]
  const out = await cli('node', 'move', 'portal-fcxlabs', `${alvo.frame.x + 40},${alvo.frame.y}`)
  assert.match(out, /^Moved/)
})

await test('nó inexistente recusa apontando o map', async () => {
  const out = await cli('node', 'move', 'Fantasma', '1,1')
  assert.match(out, /not found/)
  assert.match(out, /node map/)
})

await test('destino torto recusa em vez de gravar NaN no frame', async () => {
  const out = await cli('node', 'move', 'portal-fcxlabs', 'pra-lá')
  assert.match(out, /two numbers/)
})

await test('sair do retângulo TIRA do grupo — a mesma regra do arrasto', async () => {
  // `groupAt` é uma função só, compartilhada com o fim do arrasto do usuário.
  // Duas cópias divergiriam, e o sintoma seria um nó que o mouse tira do grupo
  // e o CLI deixa dentro.
  const g = ws.payload.groups.find((x) => x.title === 'G2 · QA')
  const membro = ws.node(g.nodeIds[0])
  assert.ok(membro, 'o grupo de referência ficou sem membro')

  const out = await cli('node', 'move', membro.id.slice(0, 8), '200000,200000')
  assert.match(out, /left 'G2 · QA'/)
  assert.equal(
    ws.payload.groups.find((x) => x.title === 'G2 · QA').nodeIds.includes(membro.id),
    false,
    'o nó saiu do retângulo mas continuou membro'
  )
})

await test('entrar no retângulo ADOTA — o outro sentido da mesma regra', async () => {
  // Arranjo próprio, numa região vazia do canvas, para a asserção não depender
  // de onde os testes anteriores deixaram as coisas: um nó emoldurado sozinho,
  // e outro trazido de fora para dentro da moldura.
  const dentro = makeCanvasNode(
    { x: 500000, y: 500000, width: 240, height: 48 },
    { type: 'text', value: { text: 'morador', fontSize: 18, fontWeight: 'regular', color: '#111', alignment: 'left', fontFamily: 'sans', isItalic: false, isUnderlined: false, isStrikethrough: false, backgroundColor: null, lineHeight: 1.3, letterSpacing: 0 } }
  )
  ws.addNode(dentro)
  const feito = await cli('node', 'group', 'G9 · Adoção', dentro.id.slice(0, 8))
  assert.match(feito, /Created group 'G9 · Adoção'/)
  const g = ws.payload.groups.find((x) => x.title === 'G9 · Adoção')

  const forasteiro = makeCanvasNode(
    { x: 600000, y: 600000, width: 100, height: 40 },
    { type: 'text', value: { text: 'forasteiro', fontSize: 18, fontWeight: 'regular', color: '#111', alignment: 'left', fontFamily: 'sans', isItalic: false, isUnderlined: false, isStrikethrough: false, backgroundColor: null, lineHeight: 1.3, letterSpacing: 0 } }
  )
  ws.addNode(forasteiro)
  assert.equal(groupTitleOf(forasteiro.id), null)

  // A folga do grupo é de 48px em volta do único membro, então a faixa logo
  // abaixo dele está dentro do retângulo e livre.
  const x = dentro.frame.x
  const y = dentro.frame.y + dentro.frame.height + 4
  assert.ok(
    y + forasteiro.frame.height < g.frame.y + g.frame.height,
    'o ponto escolhido não está dentro da moldura'
  )

  const out = await cli('node', 'move', forasteiro.id.slice(0, 8), `${x},${y}`)
  assert.match(out, /now inside 'G9 · Adoção'/)
  assert.equal(groupTitleOf(forasteiro.id), 'G9 · Adoção')
})

// ─── `node shot`: a foto, e a permissão ──────────────────────────────────────

await test('shot SEM permissão recusa, diz onde é o interruptor e aponta o map', async () => {
  const out = await cli('node', 'shot')
  assert.match(out, /^error: this terminal may not photograph/)
  assert.match(out, /Fotografar o canvas/)
  assert.match(out, /node map/, 'não ofereceu a alternativa que não precisa de permissão')
})

await test('a permissão nasce DESLIGADA num terminal novo', () => {
  // Uma permissão que nascesse ligada daria a todo nó — inclusive um vindo do
  // app nativo, que não grava a chave — o direito de fotografar a tela.
  assert.equal(terminal.content.value.canvasShotEnabled, false)
})

await test('com a permissão ligada, o verbo PASSA da porta', async () => {
  // Headless não há janela nem `electron` resolvível, então a captura falha — e
  // é justamente isso que prova que a recusa de permissão saiu do caminho: a
  // mensagem passa a ser da captura, não da porta. O handler devolve o erro em
  // vez de deixar a exceção subir, que é o outro contrato exercitado aqui.
  terminal.content.value.canvasShotEnabled = true
  const out = await cli('node', 'shot')
  assert.equal(/may not photograph/.test(out), false, 'ainda barrou na permissão')
  assert.match(out, /^error: /)
  assert.equal(/Fotografar o canvas/.test(out), false)
})

await test('destino relativo recusa — o agente não sabe qual é o cwd do main', async () => {
  terminal.content.value.canvasShotEnabled = true
  const out = await cli('node', 'shot', 'foto.png')
  assert.match(out, /absolute path/)
})

await rm(outdir, { recursive: true, force: true })
await rm(home, { recursive: true, force: true })
await rm(lab, { recursive: true, force: true })
await rm(FORA, { recursive: true, force: true })

console.log(`\n${passed} passaram, ${failed} falharam\n`)
process.exit(failed === 0 ? 0 : 1)
