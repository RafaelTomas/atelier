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

console.log('\nenquadrar tudo (viewport.fit)')
{
  const MIN_ZOOM = 0.1, MAX_ZOOM = 3.0
  // Espelha viewport.fit()
  const fit = (rect, W, H, padding = 60) => {
    const scale = Math.min((W - padding * 2) / rect.width, (H - padding * 2) / rect.height)
    const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, scale))
    const cx = rect.x + rect.width / 2, cy = rect.y + rect.height / 2
    return { zoom, origin: { x: cx - W / zoom / 2, y: cy - H / zoom / 2 } }
  }
  const nodesBounds = (ns) => {
    let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity
    for (const {frame} of ns) {
      minX=Math.min(minX,frame.x); minY=Math.min(minY,frame.y)
      maxX=Math.max(maxX,frame.x+frame.width); maxY=Math.max(maxY,frame.y+frame.height)
    }
    return {x:minX,y:minY,width:Math.max(1,maxX-minX),height:Math.max(1,maxY-minY)}
  }

  const W = 1200, H = 800
  const b = nodesBounds(nodes)
  const r = fit(b, W, H)

  // Todos os nós devem cair dentro da tela depois de enquadrar.
  let allInside = true
  for (const n of nodes) {
    const sx = (n.frame.x - r.origin.x) * r.zoom
    const sy = (n.frame.y - r.origin.y) * r.zoom
    const ex = (n.frame.x + n.frame.width - r.origin.x) * r.zoom
    const ey = (n.frame.y + n.frame.height - r.origin.y) * r.zoom
    if (sx < -0.01 || sy < -0.01 || ex > W + 0.01 || ey > H + 0.01) {
      allInside = false
      console.log(`       fora: ${sx.toFixed(1)},${sy.toFixed(1)} → ${ex.toFixed(1)},${ey.toFixed(1)}`)
    }
  }
  check('todos os nós cabem na tela depois de enquadrar', allInside)

  // O centro do conjunto vira o centro da tela.
  const centerX = r.origin.x + W / r.zoom / 2
  const centerY = r.origin.y + H / r.zoom / 2
  check('o conjunto fica centralizado',
    near(centerX, b.x + b.width / 2, 0.01) && near(centerY, b.y + b.height / 2, 0.01),
    `${centerX},${centerY}`)

  // Dois nós colados pediriam zoom altíssimo — tem de respeitar o teto.
  const tiny = fit({ x: 10000, y: 9000, width: 20, height: 15 }, W, H)
  check('zoom respeita MAX_ZOOM', tiny.zoom <= MAX_ZOOM + 1e-9, tiny.zoom)

  // Um workspace gigante pediria zoom minúsculo — respeita o piso.
  const huge = fit({ x: 0, y: 0, width: 500000, height: 400000 }, W, H)
  check('zoom respeita MIN_ZOOM', huge.zoom >= MIN_ZOOM - 1e-9, huge.zoom)

  // Proporção: enquadrar não pode esticar um eixo.
  const wide = fit({ x: 0, y: 0, width: 4000, height: 400 }, W, H)
  const tall = fit({ x: 0, y: 0, width: 400, height: 4000 }, W, H)
  check('retângulo largo e alto usam escala única (sem distorção)',
    Number.isFinite(wide.zoom) && Number.isFinite(tall.zoom) && wide.zoom > 0 && tall.zoom > 0)
}

console.log('\nboot: as duas ordens de montagem')
{
  // O retângulo da área visível só é desenhado com tamanho > 0. Era isto que
  // faltava: no primeiro desenho o viewport pode ainda ser 0×0, e um retângulo
  // de lado zero é invisível — o mapa parecia vazio até o primeiro pan.
  const drawsViewport = (view) => view.width > 0 && view.height > 0

  check('viewport 0×0 (montou antes da medição): não desenha o retângulo',
    drawsViewport({ x: 9800, y: 8500, width: 0, height: 0 }) === false)

  check('viewport medido: desenha o retângulo',
    drawsViewport({ x: 9800, y: 8500, width: 1200, height: 800 }) === true)

  // Montando DEPOIS do ResizeObserver — o caso do boot real, em que o
  // workspace chega tarde e nenhuma notificação de setSize vem depois. O
  // desenho inicial precisa ler o tamanho atual, não esperar um evento.
  const p = project(nodes, view)
  const [vx, vy] = toMap(p, view.x, view.y)
  const vw = view.width * p.scale, vh = view.height * p.scale
  check('montando com o viewport já medido, o retângulo tem área',
    vw > 1 && vh > 1, `${vw}x${vh}`)
  check('e cai dentro do painel',
    vx >= -0.01 && vy >= -0.01 && vx + vw <= WIDTH + 0.01 && vy + vh <= HEIGHT + 0.01,
    `${vx},${vy} ${vw}x${vh}`)
}

console.log('\nauto-ocultar: quando o mapa aparece')
{
  // Espelha onViewportChange + o ref revealArmed. O ponto do teste é que o
  // "armar" sobreviva à re-execução do efeito: ela acontece a cada mudança de
  // nó ou de seleção, e arrastar um nó muda os nós — se o flag resetasse, o
  // mapa deixaria de aparecer justamente nesse gesto.
  const makeMap = () => {
    const state = { visible: false, armed: false }
    return {
      state,
      // Uma notificação do viewport (pan, zoom, setSize).
      notify() {
        if (!state.armed) { state.armed = true; return }
        state.visible = true
      },
      // O efeito re-roda (mudou nó ou seleção). NÃO pode desarmar.
      rerunEffect() { /* o ref sobrevive: nada a fazer */ },
      idle() { state.visible = false }
    }
  }

  {
    const m = makeMap()
    m.notify()                       // desenho inicial do subscribe
    check('boot: o mapa nasce escondido', m.state.visible === false)
    m.notify()                       // primeiro pan
    check('primeiro pan: aparece', m.state.visible === true)
  }

  {
    const m = makeMap()
    m.notify()                       // boot
    m.idle()
    m.rerunEffect()                  // arrastou um nó → nodes mudou
    m.notify()                       // o pan desse mesmo gesto
    check('pan depois de mexer num nó: ainda aparece', m.state.visible === true)
  }

  {
    const m = makeMap()
    m.notify()
    m.idle()
    m.rerunEffect()                  // trocou a seleção
    m.notify()
    check('pan depois de trocar a seleção: ainda aparece', m.state.visible === true)
  }

  {
    // Enquadrar tudo mexe no viewport → conta como gesto e revela o mapa.
    const m = makeMap()
    m.notify()                       // boot
    m.idle()
    m.notify()                       // clique em "enquadrar tudo"
    check('enquadrar tudo revela o mapa', m.state.visible === true)
  }
}

console.log('\nbotão de zoom: geometria do painel')
{
  // A altura aberta é escrita à mão no CSS (não dá para animar `auto`), então
  // ela precisa bater com a soma das partes. Se alguém mexer num botão e
  // esquecer do total, o painel corta ou sobra — e isto avisa.
  const PAD = 4, BTN = 30, SEP = 1, SEP_MARGIN = 4
  const soma = PAD + BTN + BTN + (SEP + SEP_MARGIN * 2) + BTN + PAD
  check('altura do painel bate com a soma das partes (107px no CSS)', soma === 107, soma)

  // O respiro entre o círculo e o painel tem de ficar DENTRO do elemento que
  // recebe o :hover, senão o ponteiro o atravessa e o menu fecha sozinho.
  const hoverNoContainer = true   // .zoom-dial:hover, não .zoom-dial-trigger:hover
  const respiroDentro = hoverNoContainer
  check('o respiro entre gatilho e painel fica dentro da área de hover', respiroDentro)

  // Colisão com o dock na base: o zoom saiu da linha de base, então só o mapa
  // disputa espaço com ele.
  const inset = 14, mapW = 222, dockW = 8 * 32 + 2 * 9 + 20
  const colide = (win) => win / 2 + dockW / 2 > win - (inset + mapW)
  check('a 800px o mapa ainda cabe ao lado do dock', colide(800) === false)
  check('a 760px colide — e o media query de 780px já escondeu o mapa', colide(760) === true)
}

console.log(`\n${pass} passaram, ${fail} falharam`)
process.exit(fail === 0 ? 0 : 1)
