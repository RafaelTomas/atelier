/**
 * O que flutua SOBRE o canvas: nome do workspace, controles de vista e avisos.
 *
 * Substitui a antiga barra de topo. A troca não é cosmética: a barra ocupava
 * 46px de altura em toda a largura da janela para mostrar um nome e três
 * botões, e o canvas é o produto. Agora cada peça fica no canto onde ela é
 * procurada, e o meio da tela é todo do trabalho.
 *
 * Mora aqui, e não dentro do CanvasView, porque o aviso precisa aparecer mesmo
 * sem workspace aberto — que é justamente quando algo deu errado.
 */
import { useEffect, useState } from 'react'
import { ROPE_THICKNESS_MAX, ROPE_THICKNESS_MIN } from '@shared/types'
import { ROPE_STYLES, geometryPath, ropeLayers } from './canvas/rope-shapes'
import { dialToZoom, nodesBounds, viewport, zoomToDial } from './canvas/viewport'
import { useTopChromeBand } from './floating/chrome-band'
import { store, useStore } from './state/store'
import { WorkspaceChip } from './workspace-chip'
import type { CanvasNode } from '@shared/types'
import type { ThemeMode } from './theme'

const THEMES: { id: ThemeMode; icon: string; label: string }[] = [
  { id: 'system', icon: '◑', label: 'Sistema' },
  { id: 'light', icon: '☀', label: 'Claro' },
  { id: 'dark', icon: '☾', label: 'Escuro' }
]

/** Cores decorativas para o repouso; verde, vermelho e âmbar seguem reservados aos estados. */
const ROPE_COLORS: { value: string; label: string }[] = [
  { value: '#007aff', label: 'Azul' },
  { value: '#5856d6', label: 'Índigo' },
  { value: '#af52de', label: 'Violeta' },
  { value: '#e0245e', label: 'Rosa' },
  { value: '#1abc9c', label: 'Turquesa' }
]

export function CanvasChrome(): JSX.Element {
  const { workspace, connectingFrom, placing, notice, theme, ropeStyle, ropeThickness, ropeColor } =
    useStore()
  const [themeMenu, setThemeMenu] = useState(false)
  const [ropeMenu, setRopeMenu] = useState(false)

  // O chip e os controles de vista dividem a linha do topo com as pílulas
  // horizontais; é daqui que sai a medida de onde essa linha acaba de cada
  // lado, para que a dock comece depois dela. Ver floating/chrome-band.ts.
  useTopChromeBand()

  useEffect(() => {
    if (!themeMenu && !ropeMenu) return
    const close = (): void => {
      setThemeMenu(false)
      setRopeMenu(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [themeMenu, ropeMenu])

  return (
    <>
      {/* O ☰ que morava aqui não existe mais: a rail é permanente e o chip
          virou o botão de workspaces. Sem sidebar, o chip também não desvia
          mais para a direita de nada. */}
      <div className="canvas-chip-row">
        <WorkspaceChip />
      </div>

      <ViewControls
        theme={theme}
        themeMenu={themeMenu}
        setThemeMenu={setThemeMenu}
        ropeStyle={ropeStyle}
        ropeThickness={ropeThickness}
        ropeColor={ropeColor}
        ropeMenu={ropeMenu}
        setRopeMenu={setRopeMenu}
        nodes={workspace?.nodes ?? []}
      />

      {connectingFrom && (
        <div className="canvas-hint">clique no nó de destino para conectar · Esc cancela</div>
      )}

      {placing && (
        <div className="canvas-hint">
          arraste no canvas para definir a área {articleFor(placing.label)} · clique só usa o
          tamanho padrão · Esc cancela
        </div>
      )}

      {/* Aviso com ação: o texto continua sendo o botão de dispensar, e a ação
          (hoje o "Desfazer" do delete) é um alvo SEPARADO ao lado — senão o
          clique de tirar o aviso da frente e o de corrigir o erro seriam o
          mesmo gesto, e um deles aconteceria sem querer. */}
      {notice && (
        <div className="canvas-hint is-notice">
          <button type="button" className="notice-text" onClick={() => store.dismissNotice()}>
            {notice.text}
          </button>
          {notice.action && (
            <button
              type="button"
              className="notice-action"
              onClick={() => {
                notice.action?.run()
              }}
            >
              {notice.action.label}
            </button>
          )}
        </div>
      )}
    </>
  )
}

/**
 * Zoom, tema e gravar. O que é da VISTA e da janela — nada de criar nó, que é
 * assunto da dock.
 */
function ViewControls({
  theme,
  themeMenu,
  setThemeMenu,
  ropeStyle,
  ropeThickness,
  ropeColor,
  ropeMenu,
  setRopeMenu,
  nodes
}: {
  theme: ThemeMode
  themeMenu: boolean
  setThemeMenu: (fn: (v: boolean) => boolean) => void
  ropeStyle: (typeof ROPE_STYLES)[number]['id']
  ropeThickness: number
  ropeColor: string | null
  ropeMenu: boolean
  setRopeMenu: (fn: (v: boolean) => boolean) => void
  /** Só para o "enquadrar tudo" saber o que precisa caber na tela. */
  nodes: CanvasNode[]
}): JSX.Element {
  const [zoom, setZoom] = useState(viewport.zoom)

  // Assina o viewport direto, sem passar pela store — pan e zoom fora do React
  // é a regra 5 da migração. E só re-renderiza quando o número MOSTRADO muda:
  // sem isso, cada pixel de pan repintaria este cluster.
  useEffect(
    () =>
      viewport.subscribe((v) =>
        setZoom((current) =>
          Math.round(v.zoom * 100) === Math.round(current * 100) ? current : v.zoom
        )
      ),
    []
  )

  return (
    <div className="view-controls">
      <div className="floating vc-group">
        {/* Dial em vez dos botões − e +: o zoom vira um curso contínuo, onde
            uma passada do dedo cobre o que antes eram seis cliques. Os degraus
            não sumiram — moram no ⌘+ e ⌘−, para o ajuste de um passo só.
            A escala é logarítmica; a razão está em viewport.ts. */}
        <input
          type="range"
          className="vc-dial"
          min={0}
          max={100}
          step={1}
          value={Math.round(zoomToDial(zoom))}
          aria-label="Zoom"
          title={`Zoom: ${Math.round(zoom * 100)}%`}
          onChange={(e) => viewport.setZoom(dialToZoom(Number(e.target.value)))}
        />
        <button
          type="button"
          className="vc-zoom"
          title="Voltar a 100% (⌘0)"
          onClick={() => viewport.setZoom(1)}
        >
          {Math.round(zoom * 100)}%
        </button>
        {/* Enquadrar tudo fecha o grupo: os três antes dele mudam o zoom em
            passos, e este resolve "me perdi" de uma vez. */}
        <button
          type="button"
          className="vc-fit"
          title="Enquadrar tudo — traz todos os nós para a tela"
          aria-label="Enquadrar tudo"
          disabled={nodes.length === 0}
          onClick={() => {
            const bounds = nodesBounds(nodes)
            if (bounds) viewport.fit(bounds)
          }}
        >
          ⤢
        </button>
      </div>

      <div className="floating vc-group rope-picker" onMouseDown={(e) => e.stopPropagation()}>
        <button
          type="button"
          aria-label="Escolher desenho das conexões"
          title={`Conexões: ${ROPE_STYLES.find((style) => style.id === ropeStyle)?.label ?? 'Corda'}`}
          onClick={() => {
            setThemeMenu(() => false)
            setRopeMenu((open) => !open)
          }}
        >
          <RopeStylePreview id={ropeStyle} compact />
        </button>
        {ropeMenu && (
          <div className="context-menu rope-menu">
            {ROPE_STYLES.map((style) => (
              <button
                key={style.id}
                type="button"
                onClick={() => {
                  store.setRopeStyle(style.id)
                  setRopeMenu(() => false)
                }}
              >
                <RopeStylePreview id={style.id} />
                <span>{style.label}</span>
                <span className="rope-style-check">{ropeStyle === style.id ? '✓' : ''}</span>
              </button>
            ))}
            <span className="context-menu-label">Cor</span>
            {/* A mesma linha de amostras dos grupos e do relógio: cor é uma
                escolha visual de um clique, não outro controle para aprender. */}
            <div className="group-swatches rope-color-swatches">
              <button
                type="button"
                className={ropeColor === null ? 'swatch is-active' : 'swatch'}
                /* `--rope-theme`, e não `--rope`: escolher uma cor sobrescreve
                   `--rope` inline no :root, e esta amostra passaria a exibir a
                   cor escolhida em vez do cinza do tema que ela oferece. */
                style={{ background: 'var(--rope-theme)' }}
                title="Padrão do tema"
                aria-label="Padrão do tema"
                onClick={() => store.setRopeColor(null)}
              />
              {ROPE_COLORS.map((swatch) => (
                <button
                  key={swatch.value}
                  type="button"
                  className={ropeColor === swatch.value ? 'swatch is-active' : 'swatch'}
                  style={{ background: swatch.value }}
                  title={swatch.label}
                  aria-label={swatch.label}
                  onClick={() => store.setRopeColor(swatch.value)}
                />
              ))}
            </div>
            <label className="rope-thickness">
              Espessura
              <input
                type="range"
                min={ROPE_THICKNESS_MIN}
                max={ROPE_THICKNESS_MAX}
                step={0.05}
                value={ropeThickness}
                aria-label="Espessura das conexões"
                /* Ao vivo enquanto arrasta; grava uma vez, quando solta. */
                onChange={(e) => store.previewRopeThickness(Number(e.target.value))}
                onPointerUp={() => store.commitRopeThickness()}
                onKeyUp={() => store.commitRopeThickness()}
              />
              <output>{ropeThickness.toFixed(2).replace(/0$/, '')}×</output>
            </label>
          </div>
        )}
      </div>

      <div className="floating vc-group theme-picker" onMouseDown={(e) => e.stopPropagation()}>
        <button
          type="button"
          title={`Tema: ${THEMES.find((t) => t.id === theme)?.label ?? 'Sistema'}`}
          onClick={() => {
            setRopeMenu(() => false)
            setThemeMenu((v) => !v)
          }}
        >
          {THEMES.find((t) => t.id === theme)?.icon ?? '◑'}
        </button>
        {themeMenu && (
          <div className="context-menu theme-menu">
            {THEMES.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => {
                  store.setTheme(t.id)
                  setThemeMenu(() => false)
                }}
              >
                <span>
                  {t.icon} {t.label}
                </span>
                <span className="theme-check">{theme === t.id ? '✓' : ''}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

/** Amostra curta, pintada pelas mesmas classes usadas no canvas. */
function RopeStylePreview({
  id,
  compact = false
}: {
  id: (typeof ROPE_STYLES)[number]['id']
  compact?: boolean
}): JSX.Element {
  return (
    <svg
      className={`rope-style-preview${compact ? ' rope-picker-button-preview' : ''}`}
      viewBox="0 0 28 14"
      aria-hidden="true"
    >
      {ropeLayers(id).map((layer) => (
        <path
          key={layer.name || 'single'}
          className={`rope rope-shape-${id}${layer.name ? ` rope-layer-${layer.name}` : ''} rope-idle`}
          d={
            layer.geometry === 'center'
              ? ropeStylePreviewPath(id)
              : geometryPath(layer.geometry, SWATCH_POINTS, SWATCH_SCALE)
          }
        />
      ))}
    </svg>
  )
}

/**
 * A amostra do seletor é pequena demais para a hélice de canvas: a corda vai a
 * 4.5 de corpo no CSS, e o gomo acompanha pela mesma fração.
 */
const SWATCH_SCALE = 0.45
/** A mesma curva de `ropeStylePreviewPath`, amostrada — a hélice quer pontos. */
const SWATCH_POINTS = Array.from({ length: 24 }, (_, i) => {
  const t = i / 23
  const u = 1 - t
  return {
    x: u * u * u * 2 + 3 * u * u * t * 8 + 3 * u * t * t * 20 + t * t * t * 26,
    y: u * u * u * 5 + 3 * u * u * t * 12 + 3 * u * t * t * 12 + t * t * t * 5
  }
})

function ropeStylePreviewPath(id: (typeof ROPE_STYLES)[number]['id']): string {
  if (id === 'line') return 'M 2 7 H 26'
  if (id === 'circuit') return 'M 2 10 H 10 V 4 H 18 V 7 H 26'
  // Os desenhos em camadas TÊM de usar esta curva: é a mesma que o
  // `SWATCH_POINTS` amostra para a geometria derivada. Devolver outra aqui
  // colocaria a sombra da trança num traçado diferente do dos fios dela.
  if (id === 'dotted' || id === 'rope' || id === 'chain' || id === 'braid') {
    return 'M 2 5 C 8 12, 20 12, 26 5'
  }
  return 'M 2 7 C 8 2, 20 12, 26 7'
}

/** "da nota" / "do terminal" — o rótulo do item vem sem artigo. */
function articleFor(label: string): string {
  const feminine = /^(nota|legenda|árvore)/.test(label)
  return `${feminine ? 'da' : 'do'} ${label}`
}
