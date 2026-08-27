/**
 * Botão do canvas — o gesto mais barato que existe aqui.
 *
 * Um comando repetido custava um terminal inteiro: abrir o diálogo, escolher
 * ícone, cor, diretório e digitar a linha. Da segunda vez em diante ninguém
 * quer configurar nada — quer CLICAR. É isso que este nó é.
 *
 * Não é um caso novo do enum de conteúdo: é `widget` com `kind: 'button'`, e a
 * configuração mora em `view` (ver ButtonConfig em shared/types).
 *
 * O estado PENDENTE é a regra de confiança do canvas multi-agente: um botão
 * guarda uma linha de comando e a dispara com um clique, então tudo que vem do
 * CLI nasce inerte, com o comando à vista e uma faixa de aceite. Sem isso, um
 * agente teria execução arbitrária no shell do usuário disfarçada de UI.
 */
import { useRef, useState } from 'react'
import type { CanvasNode, WidgetContent } from '@shared/types'
import { buttonActionSummary, readButtonConfig } from '@shared/types'
import { Icon } from '../node-icons'
import { store, useStore } from '../state/store'

/** Abaixo disto o rótulo não cabe sem espremer o ícone — fica só o ícone. */
const LABEL_MIN_SIDE = 64

/**
 * Folga, em px de tela, entre "cliquei" e "arrastei".
 *
 * O corpo do botão NÃO para o mousedown: se parasse, o canvas nunca entraria em
 * `mayDrag` e o nó só poderia ser redimensionado — que foi exatamente o que
 * aconteceu. Deixando o evento subir, o nó arrasta como qualquer outro, e o
 * `click` que o navegador dispara no fim do arrasto é descartado aqui.
 *
 * Um pouco maior que o DRAG_THRESHOLD do canvas (3 px), de propósito: entre os
 * dois valores o gesto move o nó E não dispara — e disparar `npm run dev` por
 * um tremor de mão é o erro caro dos dois.
 */
const CLICK_SLOP = 5

export function ButtonWidget({
  node,
  content
}: {
  node: CanvasNode
  content: WidgetContent
}): JSX.Element {
  const { buttonRuns } = useStore()
  const config = readButtonConfig(content.view)
  const [confirming, setConfirming] = useState(false)
  const pressedAt = useRef<{ x: number; y: number } | null>(null)
  const run = buttonRuns[node.id]
  const summary = buttonActionSummary(config)
  const compact = node.frame.width < LABEL_MIN_SIDE || node.frame.height < LABEL_MIN_SIDE

  // Proposto por um agente: mostra O QUE dispara e não dispara nada. O aceite
  // acontece AQUI, no canvas, e não no chat onde o botão foi pedido — é neste
  // clique que o usuário lê o comando exato.
  if (config.pending) {
    return (
      <div className="button-widget is-pending" style={{ '--btn-color': config.color } as React.CSSProperties}>
        <div className="button-pending-head">
          <Icon name={config.icon} size={18} />
          <span className="button-pending-label">{config.label || 'Botão'}</span>
        </div>
        <code className="button-pending-cmd" title={summary}>
          {summary || '(sem ação)'}
        </code>
        {config.proposedBy && <span className="button-pending-by">proposto por {config.proposedBy}</span>}
        <div className="button-pending-actions">
          <button
            type="button"
            className="btn is-primary"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={() => void store.acceptButton(node.id)}
          >
            Aceitar
          </button>
          <button
            type="button"
            className="btn"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={() => void store.removeNode(node.id)}
          >
            Descartar
          </button>
        </div>
      </div>
    )
  }

  // A confirmação é INLINE, não um modal: o nó tem 88 px, e uma folha no meio
  // da tela para perguntar "rodar npm test?" é desproporcional ao que se pede.
  if (confirming) {
    return (
      <div className="button-widget is-confirming" style={{ '--btn-color': config.color } as React.CSSProperties}>
        <span className="button-confirm-text" title={summary}>
          {summary}
        </span>
        <div className="button-confirm-actions">
          <button
            type="button"
            className="btn is-primary"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={() => {
              setConfirming(false)
              void store.runButton(node.id)
            }}
          >
            Rodar
          </button>
          <button
            type="button"
            className="btn"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={() => setConfirming(false)}
          >
            Não
          </button>
        </div>
      </div>
    )
  }

  return (
    <button
      type="button"
      className={[
        'button-widget',
        run === 'running' ? 'is-running' : '',
        run === 'failed' ? 'is-failed' : '',
        compact ? 'is-compact' : ''
      ]
        .filter(Boolean)
        .join(' ')}
      style={{ '--btn-color': config.color } as React.CSSProperties}
      title={summary ? `${config.label || 'Botão'} — ${summary}` : 'Botão sem ação — dê dois cliques para configurar'}
      // Sem stopPropagation: o mousedown precisa chegar ao canvas para o nó
      // poder ser arrastado (ver CLICK_SLOP).
      //
      // E sem duplo clique para editar, que era o plano: o primeiro clique de
      // um duplo JÁ dispara, então tentar configurar rodaria o comando duas
      // vezes. Editar é o lápis da barra de ações, que aparece com o nó
      // selecionado — um clique aqui dispara, sempre.
      onMouseDown={(e) => {
        pressedAt.current = { x: e.clientX, y: e.clientY }
      }}
      onClick={(e) => {
        const from = pressedAt.current
        pressedAt.current = null
        if (from && Math.hypot(e.clientX - from.x, e.clientY - from.y) > CLICK_SLOP) return
        if (config.confirm) setConfirming(true)
        else void store.runButton(node.id)
      }}
    >
      <span className="button-widget-icon">
        <Icon name={config.icon} size={compact ? 20 : 28} />
      </span>
      {!compact && <span className="button-widget-label">{config.label || 'Botão'}</span>}
    </button>
  )
}
