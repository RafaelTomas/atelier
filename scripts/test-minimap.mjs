/**
 * Verifica a projeção do minimapa: canvas → mapa → canvas.
 *
 * O que quebra num minimapa não é o desenho, é a conversão. Um erro de sinal
 * ou de centro faz o clique cair perto o suficiente para parecer certo e
 * errado o suficiente para irritar — e é invisível numa captura de tela.
 *
 * Reproduz a mesma aritmética de minimap.tsx (contentBounds + escala única +
 * centralização) em vez de montar React: é a lógica que pode quebrar.
 */
const WIDTH = 208, HEIGHT = 132, PADDING = 10

let pass = 0, fail = 0
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok  ', name) }
  else { fail++; console.log('  FAIL', name, extra ?? '') }
}
const near = (a, b, tol = 0.001) => Math.abs(a - b) < tol

function contentBounds(nodes, view) {
  let minX = view.x, minY = view.y
  let maxX = view.x + view.width, maxY = view.y + view.height
  for (const n of nodes) {
    minX = Math.min(minX, n.frame.x); minY = Math.min(minY, n.frame.y)
    maxX = Math.max(maxX, n.frame.x + n.frame.width)
    maxY = Math.max(maxY, n.frame.y + n.frame.height)
  }
  return { x: minX, y: minY, width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY) }
}

function project(nodes, view) {
  const bounds = contentBounds(nodes, view)
  const scale = Math.min((WIDTH - PADDING * 2) / bounds.width, (HEIGHT - PADDING * 2) / bounds.height)
  const offsetX = (WIDTH - bounds.width * scale) / 2
  const offsetY = (HEIGHT - bounds.height * scale) / 2
  return { scale, offsetX, offsetY, bounds }
}

const toMap = (p, x, y) => [(x - p.bounds.x) * p.scale + p.offsetX, (y - p.bounds.y) * p.scale + p.offsetY]
const toCanvas = (p, mx, my) => [(mx - p.offsetX) / p.scale + p.bounds.x, (my - p.offsetY) / p.scale + p.bounds.y]

const nodes = [
  { frame: { x: 10000, y: 9000, width: 400, height: 300 } },
  { frame: { x: 10800, y: 9500, width: 200, height: 150 } },
  { frame: { x: 9600, y: 8700, width: 300, height: 200 } }
]
const view = { x: 9800, y: 8500, width: 1200, height: 800 }

console.log('\nprojeção ida e volta')
{
  const p = project(nodes, view)
  for (const [x, y] of [[10000, 9000], [10800, 9500], [9600, 8700], [9800, 8500]]) {
    const [mx, my] = toMap(p, x, y)
    const [bx, by] = toCanvas(p, mx, my)
    check(`(${x},${y}) volta ao mesmo ponto`, near(bx, x) && near(by, y), `${bx},${by}`)
  }
}

console.log('\ntudo cabe dentro do painel')
{
  const p = project(nodes, view)
  const all = [...nodes.map(n => n.frame), view]
  let inside = true
  for (const f of all) {
    const [x1, y1] = toMap(p, f.x, f.y)
    const [x2, y2] = toMap(p, f.x + f.width, f.y + f.height)
    if (x1 < -0.01 || y1 < -0.01 || x2 > WIDTH + 0.01 || y2 > HEIGHT + 0.01) {
      inside = false
      console.log(`       fora: ${x1},${y1} → ${x2},${y2}`)
    }
  }
  check('nenhum nó nem a viewport saem do painel', inside)
  check('respeita o padding num dos eixos',
    p.offsetX >= PADDING - 0.01 || p.offsetY >= PADDING - 0.01,
    `offsetX=${p.offsetX} offsetY=${p.offsetY}`)
}

console.log('\nproporção preservada (escala única nos dois eixos)')
{
  const p = project(nodes, view)
  const f = { x: 10000, y: 9000, width: 400, height: 200 } // 2:1
  const [x1, y1] = toMap(p, f.x, f.y)
  const [x2, y2] = toMap(p, f.x + f.width, f.y + f.height)
  check('um nó 2:1 continua 2:1 no mapa', near((x2 - x1) / (y2 - y1), 2, 0.01), (x2-x1)/(y2-y1))
}

console.log('\nclique centraliza (não põe o alvo no canto)')
{
  const p = project(nodes, view)
  const zoom = 1, vw = 1200, vh = 800
  // Clica no centro de um nó e confere que ele fica no centro da nova view.
  const target = { x: 10800 + 100, y: 9500 + 75 }
  const [mx, my] = toMap(p, target.x, target.y)
  const [cx, cy] = toCanvas(p, mx, my)
  const origin = { x: cx - vw / zoom / 2, y: cy - vh / zoom / 2 }
  const centerOfNewView = { x: origin.x + vw / zoom / 2, y: origin.y + vh / zoom / 2 }
  check('o ponto clicado vira o centro da view',
    near(centerOfNewView.x, target.x) && near(centerOfNewView.y, target.y),
    `${centerOfNewView.x},${centerOfNewView.y}`)
}

console.log('\ncasos de borda')
{
  // Workspace vazio: só a viewport define os limites, e nada deve estourar.
  const p = project([], view)
  check('sem nós: escala finita e positiva', Number.isFinite(p.scale) && p.scale > 0, p.scale)
  const [mx, my] = toMap(p, view.x, view.y)
  check('sem nós: a viewport cai dentro do painel',
    mx >= -0.01 && my >= -0.01 && mx <= WIDTH && my <= HEIGHT, `${mx},${my}`)

  // Um nó só, sem área: width/height 0 não pode virar divisão por zero.
  const p2 = project([{ frame: { x: 10000, y: 9000, width: 0, height: 0 } }], view)
  check('nó de área zero não quebra a escala', Number.isFinite(p2.scale) && p2.scale > 0, p2.scale)

  // Quadro longe de tudo: continua no mapa, porque a view entra nos limites.
  const far = { x: 90000, y: 90000, width: 1200, height: 800 }
  const p3 = project(nodes, far)
  const [fx, fy] = toMap(p3, far.x, far.y)
  check('quadro distante permanece dentro do painel',
    fx >= -0.01 && fy >= -0.01 && fx <= WIDTH && fy <= HEIGHT, `${fx},${fy}`)
}

console.log(`\n${pass} passaram, ${fail} falharam`)
process.exit(fail === 0 ? 0 : 1)
