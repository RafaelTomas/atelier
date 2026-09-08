/**
 * Camada 4: as cordas.
 *
 * SVG num contêiner com o mesmo transform dos nós, então os paths ficam em
 * coordenadas de canvas e o pan/zoom sai de graça. Os `d` são escritos direto
 * no DOM pelo tick da física — nunca via estado do React.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { CanvasNode, Connection, Point, UUID } from '@shared/types'
import { clockWillFire, readClockConfig } from '@shared/clock'
import { IconScissors } from '../icons'
import { store, useStore } from '../state/store'
import { RopeSimulation, ropePath } from './rope'
import { ROPE_STYLES, geometryPath, ropeLayers, shapePath } from './rope-shapes'
import { rectCenter, viewport } from './viewport'

/**
 * O que o cabo diz quando o cursor para em cima dele.
 *
 * Só o `clockAction` tem texto: ele é o único cabo cujo efeito não se lê nas
 * duas pontas. Um cabo de nota ou de portal descreve uma LIGAÇÃO — o agente
 * alcança aquele artefato —, e ver os dois nós já explica. Este descreve um
 * EVENTO com direção e com efeito colateral, e "ao terminar → este botão" é o
 * que separa um cabo decorativo de um comando que vai rodar sozinho.
 */
function ropeTitle(conn: Connection, nodes: CanvasNode[]): string | null {
  if (conn.kind !== 'clockAction') return null
  const button = nodes.find((n) => n.id === conn.nodeIdB)
  const label =
    button?.content.type === 'widget' ? button.content.value.view.label || 'o botão' : 'o botão'
  // O estado entra no texto, e não só na cor: a cor diz que algo mudou, o texto
  // diz O QUE, e para quem não distingue os dois âmbares é a única leitura.
  return clockArmed(conn, nodes)
    ? `ao terminar → ${label}`
    : `${label} — parado, nada vai disparar`
}

/**
 * O relógio deste cabo tem um disparo a caminho?
 *
 * O relógio é sempre o lado A, canônico desde o `WorkspaceManager`, então é uma
 * busca só. `false` para qualquer cabo que não seja de relógio — quem chama já
 * filtrou, e responder `false` é mais seguro que assumir.
 */
function clockArmed(conn: Connection, nodes: CanvasNode[]): boolean {
  if (conn.kind !== 'clockAction') return false
  const clock = nodes.find((n) => n.id === conn.nodeIdA)
  if (clock?.content.type !== 'widget' || clock.content.value.kind !== 'clock') return false
  return clockWillFire(readClockConfig(clock.content.value.view))
}

const STATUS_CLASS: Record<string, string> = {
  idle: 'idle',
  communicating: 'communicating',
  error: 'error'
}

interface Props {
  nodes: CanvasNode[]
  connections: Connection[]
  /** Muda a cada frame de arrasto para reancorar as cordas em tempo real. */
  liveFrames: React.MutableRefObject<Map<UUID, Point>>
  /** Membros de grupos colapsados — as cordas deles somem junto com os nós. */
  hiddenNodes?: Set<UUID>
}

export function ConnectionsLayer({
  nodes,
  connections,
  liveFrames,
  hiddenNodes
}: Props): JSX.Element {
  const { ropeStyle, ropeThickness } = useStore()
  const physics = ROPE_STYLES.find((style) => style.id === ropeStyle)?.physics ?? true
  const layers = ropeLayers(ropeStyle)
  /**
   * As camadas em ref, e não só na closure.
   *
   * `sim.onTick` é registrado UMA vez, na montagem, e congelaria a lista de
   * camadas do desenho que estivesse ativo ali. Trocar de desenho redesenhava
   * certo pelo efeito de sincronia, mas o primeiro tique da física — ou seja, o
   * instante em que alguém arrasta um nó — reescrevia tudo com a geometria do
   * desenho ANTERIOR: a corrente virava trança na primeira mexida.
   */
  const layersRef = useRef(layers)
  layersRef.current = layers
  /**
   * O fator também em ref, e pela mesma razão das camadas: o `sim.onTick` é
   * registrado uma vez e leria para sempre a espessura da montagem.
   */
  const scaleRef = useRef(ropeThickness)
  scaleRef.current = ropeThickness
  const svgRef = useRef<SVGSVGElement>(null)
  const simRef = useRef<RopeSimulation | null>(null)
  // Uma conexão pode ter mais de um traço visível (ver ropeLayers): a corda de
  // sisal é cinco acabamentos empilhados. Guardar a LISTA, e não um elemento,
  // é o que permite escrever o mesmo `d` em todos de uma vez.
  const pathsRef = useRef(new Map<UUID, SVGPathElement[]>())
  // Path invisível e mais grosso por cima de cada corda, só para dar uma área
  // de clique generosa — a corda visível tem 2px, quase impossível de acertar.
  const hitPathsRef = useRef(new Map<UUID, SVGPathElement>())

  // Tesourinha no hover: mostra perto do cursor, não na corda (a corda se move
  // sozinha pela física — perseguir o ponto exato seria mais trabalho para um
  // ganho que ninguém nota).
  const [scissors, setScissors] = useState<{ id: UUID; x: number; y: number } | null>(null)
  const hideTimer = useRef<number | null>(null)

  const cancelHide = (): void => {
    if (hideTimer.current !== null) {
      window.clearTimeout(hideTimer.current)
      hideTimer.current = null
    }
  }
  const scheduleHide = (): void => {
    cancelHide()
    hideTimer.current = window.setTimeout(() => setScissors(null), 150)
  }

  /**
   * Escreve a conexão inteira: o traço do centro nos acabamentos que o seguem,
   * a hélice nos que são gomo, e SEMPRE o centro no path de clique — a
   * tesourinha tem de responder ao longo da corda, não nos fios dela.
   *
   * `points` só existe nos desenhos com física; sem ele a hélice é pulada, e é
   * por isso que ela é privilégio dos que passam pelo Verlet.
   */
  const writePath = (id: UUID, d: string, points?: Point[]): void => {
    const paths = pathsRef.current.get(id)
    if (paths) {
      // Um cache por escrita: a trança pede o mesmo fio duas vezes (inteiro e
      // só a frente), e o sisal pede a hélice para o gomo e para o brilho.
      const derived = new Map<string, string>()
      const current = layersRef.current
      for (let i = 0; i < paths.length; i++) {
        const el = paths[i]
        const geometry = current[i]?.geometry ?? 'center'
        if (!el) continue
        if (geometry === 'center') {
          el.setAttribute('d', d)
          continue
        }
        if (!points) continue
        let derivedPath = derived.get(geometry)
        if (derivedPath === undefined) {
          derivedPath = geometryPath(geometry, points, scaleRef.current)
          derived.set(geometry, derivedPath)
        }
        el.setAttribute('d', derivedPath)
      }
    }
    hitPathsRef.current.get(id)?.setAttribute('d', d)
  }

  /**
   * As cordas que aparecem: basta UMA das pontas estar dobrada para a corda
   * sair. Ela ligaria a moldura fechada ao lugar onde o nó estaria — um fio
   * saindo de um retângulo e morrendo no vazio.
   *
   * Sai do desenho e da reancoragem, mas NÃO da simulação: colapsar não move
   * nó nenhum, então a corda guardada volta exatamente como estava ao expandir.
   * Removê-la faria a expansão remontá-la a partir dos `ropePoints` do disco,
   * que podem estar velhos — e a corda daria um pulo na tela.
   */
  const visible = useMemo(() => {
    if (!hiddenNodes?.size) return connections
    return connections.filter(
      (c) => !hiddenNodes.has(c.nodeIdA) && !hiddenNodes.has(c.nodeIdB)
    )
  }, [connections, hiddenNodes])

  // Física: uma instância viva enquanto a camada existir
  useEffect(() => {
    const sim = new RopeSimulation()
    simRef.current = sim
    sim.onTick = (points) => {
      for (const [id, pts] of points) {
        writePath(id, ropePath(pts), pts)
      }
    }
    return () => {
      sim.clear()
      simRef.current = null
    }
  }, [])

  // Sincroniza as cordas com a lista de conexões
  useEffect(() => {
    const sim = simRef.current
    if (!sim) return

    const centerOf = (id: UUID): Point | null => {
      const live = liveFrames.current.get(id)
      if (live) return live
      const node = nodes.find((n) => n.id === id)
      return node ? rectCenter(node.frame) : null
    }

    for (const conn of visible) {
      const a = centerOf(conn.nodeIdA)
      const b = centerOf(conn.nodeIdB)
      if (!a || !b) continue
      if (!physics) {
        writePath(conn.id, shapePath(ropeStyle, a, b))
      } else if (sim.has(conn.id)) {
        sim.updateAnchors(conn.id, a, b)
      } else {
        const existing = conn.ropePoints.length
          ? conn.ropePoints.map(([x, y]) => ({ x, y }))
          : undefined
        sim.add(conn.id, a, b, existing)
      }
      if (physics) {
        const points = sim.pointsFor(conn.id)
        if (points) writePath(conn.id, ropePath(points), points)
      }
    }
    // A varredura é sobre o que a SIMULAÇÃO carrega, não sobre a lista de
    // conexões: uma corda cuja conexão foi apagada não aparece mais na lista, e
    // iterar a lista nunca a alcançaria — ela ficava na física para sempre. A
    // lista completa, e não a visível, para a corda dobrada sobreviver.
    const live = new Set(physics ? connections.map((c) => c.id) : [])
    for (const id of sim.ids()) if (!live.has(id)) sim.remove(id)
  }, [connections, visible, nodes, liveFrames, physics, ropeStyle, ropeThickness])

  // Reancora durante o arrasto, a 60fps, sem passar pelo React
  useEffect(() => {
    let frame = 0
    const tick = (): void => {
      const sim = simRef.current
      if (sim && liveFrames.current.size > 0) {
        for (const conn of visible) {
          const a = liveFrames.current.get(conn.nodeIdA)
          const b = liveFrames.current.get(conn.nodeIdB)
          if (!a && !b) continue
          const nodeA = nodes.find((n) => n.id === conn.nodeIdA)
          const nodeB = nodes.find((n) => n.id === conn.nodeIdB)
          if (!nodeA || !nodeB) continue
          const anchorA = a ?? rectCenter(nodeA.frame)
          const anchorB = b ?? rectCenter(nodeB.frame)
          if (physics) sim.updateAnchors(conn.id, anchorA, anchorB)
          else writePath(conn.id, shapePath(ropeStyle, anchorA, anchorB))
        }
      }
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [visible, nodes, liveFrames, physics, ropeStyle, ropeThickness])

  // Acompanha o transform do viewport
  useEffect(() => {
    return viewport.subscribe(() => {
      const svg = svgRef.current
      if (svg) svg.style.transform = viewport.transform()
    })
  }, [])

  return (
    <>
      {/* O fator desce por variável CSS: daqui ele alcança a espessura de todo
          traço de todo desenho sem que nenhum deles precise saber que existe
          uma preferência. A geometria recebe o mesmo número pelo `scaleRef`. */}
      <svg
        ref={svgRef}
        className="connections-layer"
        overflow="visible"
        style={{ '--rope-scale': ropeThickness } as React.CSSProperties}
      >
        {visible.map((conn) => (
          <path
            key={`hit-${conn.id}`}
            ref={(el) => {
              if (el) hitPathsRef.current.set(conn.id, el)
              else hitPathsRef.current.delete(conn.id)
            }}
            fill="none"
            stroke="transparent"
            strokeWidth={16}
            style={{ pointerEvents: 'stroke', cursor: 'pointer' }}
            onMouseMove={(e) => {
              cancelHide()
              setScissors({ id: conn.id, x: e.clientX, y: e.clientY })
            }}
            onMouseLeave={scheduleHide}
          >
            {/* No path de ACERTO, não no visível: é ele que tem
                `pointer-events`, e um `<title>` num traço inerte nunca
                apareceria. */}
            {ropeTitle(conn, nodes) && <title>{ropeTitle(conn, nodes)}</title>}
          </path>
        ))}
        {visible.map((conn) => {
          const status = STATUS_CLASS[conn.status] ?? STATUS_CLASS.idle
          // Lido no RENDER, e não escrito no DOM pelo caminho imperativo: armar
          // um relógio é gesto semântico, passa pela store e já re-renderiza
          // esta camada. O tique de segundo do coordenador NÃO passa pela
          // store, então isto não custa um render por segundo.
          const armed = clockArmed(conn, nodes)
          return (
            <g key={conn.id}>
              {layers.map((layer, i) => (
                <path
                  key={layer.name || 'single'}
                  ref={(el) => {
                    // Trocar de desenho monta e desmonta traços em ordens que
                    // não dá para prever daqui, então o índice pode ficar vago
                    // por um instante. O `writePath` já pula o vago — limpar a
                    // lista inteira aqui é que apagaria um traço vivo.
                    const list = pathsRef.current.get(conn.id) ?? []
                    if (el) {
                      list[i] = el
                      pathsRef.current.set(conn.id, list)
                      return
                    }
                    delete list[i]
                    // Corda cortada: sem isto a entrada ficava no mapa com uma
                    // lista vazia para sempre, e o mapa só crescia ao longo da
                    // sessão. Some quando o último traço se vai.
                    if (list.some((path) => path)) pathsRef.current.set(conn.id, list)
                    else pathsRef.current.delete(conn.id)
                  }}
                  className={`rope rope-shape-${ropeStyle}${layer.name ? ` rope-layer-${layer.name}` : ''} rope-${status} rope-kind-${conn.kind}${armed ? ' rope-armed' : ''}`}
                  fill="none"
                />
              ))}
            </g>
          )
        })}
      </svg>

      {scissors && (
        <button
          type="button"
          className="rope-scissors"
          title="Cortar conexão"
          style={{ position: 'fixed', left: scissors.x, top: scissors.y }}
          onMouseEnter={cancelHide}
          onMouseLeave={scheduleHide}
          onClick={() => {
            void store.removeConnection(scissors.id)
            setScissors(null)
          }}
        >
          <IconScissors size={14} />
        </button>
      )}
    </>
  )
}
