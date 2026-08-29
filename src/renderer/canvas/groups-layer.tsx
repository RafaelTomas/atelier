/**
 * Camada das molduras de grupo — entre os desenhos e os nós.
 *
 * ATRÁS dos nós, sempre: a moldura é o fundo em que eles estão, e um retângulo
 * por cima de um terminal tiraria dele metade da tela. Por isso também o corpo
 * é `pointer-events: none` e só a faixa do título e a borda são clicáveis — é
 * o que permite pegar um nó de dentro do grupo sem tirar a moldura da frente.
 *
 * Como o resto do canvas, nada de alta frequência passa pelo React: o transform
 * do pan/zoom, a compensação de escala da faixa e a fixação dela no topo
 * visível são escritos direto no DOM a cada notificação do viewport. O React só
 * vê o CONJUNTO de grupos visíveis, e só quando ele muda de fato.
 */
import { useEffect, useRef, useState } from 'react'
import type { NodeGroup, UUID } from '@shared/types'
import { GROUP_TITLE_HEIGHT } from './group-geometry'
import { CULL_MARGIN, rectsIntersect, viewport } from './viewport'

interface Props {
  groups: NodeGroup[]
  selectedId: UUID | null
  /** Grupo em foco: ele fica opaco e o resto do canvas apaga. */
  isolatedId: UUID | null
  /** Renomear em linha — o duplo-clique na faixa arma; a camada só reporta. */
  editingId: UUID | null
  onEditDone: (id: UUID, title: string) => void
  onEditCancel: () => void
}

/** As oito alças da moldura, iguais às do nó. */
const EDGES = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] as const

export function GroupsLayer({
  groups,
  selectedId,
  isolatedId,
  editingId,
  onEditDone,
  onEditCancel
}: Props): JSX.Element {
  const layerRef = useRef<HTMLDivElement>(null)
  const [visibleIds, setVisibleIds] = useState<Set<UUID>>(new Set())

  // `groups` nas deps, e não num ref: `subscribe` notifica na hora em que se
  // assina, então reassinar é o que recalcula o conjunto visível quando um
  // grupo NASCE. Sem isso a moldura recém-criada só apareceria no primeiro pan
  // — o viewport não é notificado de mudanças no workspace.
  useEffect(() => {
    return viewport.subscribe(() => {
      const layer = layerRef.current
      if (!layer) return
      layer.style.transform = viewport.transform()

      /**
       * O inverso do zoom, para a faixa do título manter tamanho constante em
       * PIXELS DE TELA. Abaixo de ~40% o corpo dos nós já é ilegível, e é
       * justamente aí que o rótulo do grupo precisa continuar legível: em 25%
       * é ele que vira a unidade de leitura do canvas.
       *
       * Uma variável CSS na camada, e não um transform por faixa: é uma escrita
       * por frame independentemente de quantos grupos estejam na tela. Escalar
       * a faixa inteira não serviria — a largura dela acompanha a moldura, e
       * um `scale` a esticaria junto para fora do retângulo.
       */
      layer.style.setProperty('--group-inv', String(1 / viewport.zoom))

      const view = viewport.visibleRect(CULL_MARGIN)
      const next = new Set<UUID>()
      for (const g of groups) if (rectsIntersect(g.frame, view)) next.add(g.id)
      setVisibleIds((prev) => {
        if (prev.size === next.size && [...next].every((id) => prev.has(id))) return prev
        return next
      })

      // A faixa presa no topo visível. Numa moldura maior que a tela o rótulo
      // sairia por cima com o primeiro pan, e o grupo viraria um retângulo sem
      // nome — que é o oposto do que uma moldura com título serve para fazer.
      const bandHeight = GROUP_TITLE_HEIGHT / viewport.zoom
      for (const g of groups) {
        if (!next.has(g.id)) continue
        const band = layer.querySelector<HTMLElement>(
          `[data-group-id="${g.id}"] > .group-title`
        )
        if (!band) continue
        const limit = Math.max(0, g.frame.height - bandHeight)
        const offset = Math.min(limit, Math.max(0, viewport.origin.y - g.frame.y))
        band.style.transform = offset > 0 ? `translateY(${offset}px)` : ''
      }
    })
  }, [groups])

  const visible = groups.filter((g) => visibleIds.has(g.id))

  return (
    <div ref={layerRef} className="groups-layer">
      {visible.map((group) => (
        <div
          key={group.id}
          data-group-id={group.id}
          className={[
            'group',
            group.id === selectedId ? 'is-selected' : '',
            group.isCollapsed ? 'is-collapsed' : '',
            // No modo foco, os OUTROS apagam. O próprio grupo focado nunca
            // apaga — ele é o motivo de o modo estar ligado.
            isolatedId && group.id !== isolatedId ? 'is-dimmed' : ''
          ]
            .filter(Boolean)
            .join(' ')}
          style={{
            left: group.frame.x,
            top: group.frame.y,
            width: group.frame.width,
            // Colapsado, o retângulo é a própria faixa: a altura vem do
            // conteúdo, senão sobraria a moldura vazia do tamanho de antes.
            height: group.isCollapsed ? undefined : group.frame.height,
            // A cor entra por variável para faixa, borda e realce lerem a mesma.
            ['--group-color' as string]: group.color
          }}
        >
          <div className="group-title" data-group-title={group.id}>
            {editingId === group.id ? (
              <input
                className="group-title-input"
                defaultValue={group.title}
                autoFocus
                // O clique dentro do campo é do campo: sem isto o mousedown
                // desce para a faixa e começa a arrastar o grupo inteiro.
                onMouseDown={(e) => e.stopPropagation()}
                onBlur={(e) => onEditDone(group.id, e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') onEditDone(group.id, e.currentTarget.value)
                  if (e.key === 'Escape') onEditCancel()
                }}
              />
            ) : (
              <span className="group-title-text">{group.title}</span>
            )}
            <span className="group-count">
              {group.nodeIds.length} {group.nodeIds.length === 1 ? 'nó' : 'nós'}
            </span>
          </div>

          {/* Alças só na moldura selecionada: oito retângulos invisíveis por
              grupo, sempre presentes, roubariam o clique dos nós da borda. */}
          {group.id === selectedId &&
            !group.isCollapsed &&
            EDGES.map((edge) => <div key={edge} data-group-handle={edge} />)}
        </div>
      ))}
    </div>
  )
}
