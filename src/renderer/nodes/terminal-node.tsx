/**
 * Nó Terminal — SwiftTerm/PTY vira xterm.js + node-pty.
 *
 * SOBRE ZOOM (risco §4.2 do plano de migração): o xterm renderiza em <canvas>,
 * e escalar canvas por CSS borra o texto. A mitigação implementada aqui é a
 * mesma do plano: abaixo de FREEZE_ZOOM o terminal é substituído por um
 * placeholder estático e para de renderizar. Terminal fora da viewport nem
 * chega a ser montado (a virtualização do canvas cuida disso).
 */
import { useEffect, useRef, useState } from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import type { CanvasNode, TerminalContent, UUID } from '@shared/types'
import { viewport } from '../canvas/viewport'
import { useStore } from '../state/store'
import '@xterm/xterm/css/xterm.css'

const FREEZE_ZOOM = 0.45

interface Props {
  node: CanvasNode
  content: TerminalContent
  workspaceId: UUID
}

/**
 * O xterm precisa das cores em JS — não enxerga as custom properties. Lemos os
 * tokens do CSS para o terminal seguir o tema junto com o resto da UI.
 */
function terminalTheme(): { background: string; foreground: string } {
  const css = getComputedStyle(document.documentElement)
  return {
    background: css.getPropertyValue('--term-bg').trim() || '#101014',
    foreground: css.getPropertyValue('--term-fg').trim() || '#e6e6e6'
  }
}

export function TerminalNode({ node, content, workspaceId }: Props): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const [frozen, setFrozen] = useState(viewport.zoom < FREEZE_ZOOM)
  const { theme } = useStore()

  useEffect(() => viewport.subscribe((v) => setFrozen(v.zoom < FREEZE_ZOOM)), [])

  // Troca de tema com o terminal já montado: repinta sem recriar o PTY.
  // No modo 'system' o valor da store não muda quando o SO alterna, então o
  // media query é ouvido também — senão o terminal ficaria com a cor antiga.
  useEffect(() => {
    const repaint = (): void => {
      if (termRef.current) termRef.current.options.theme = terminalTheme()
    }
    repaint()
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    mq.addEventListener('change', repaint)
    return () => mq.removeEventListener('change', repaint)
  }, [theme])

  useEffect(() => {
    if (frozen || !hostRef.current || termRef.current) return

    const term = new Terminal({
      fontFamily: content.fontFamily ?? 'ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: content.fontSize ?? 12,
      cursorBlink: true,
      allowProposedApi: true,
      theme: terminalTheme(),
      scrollback: 5000
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(hostRef.current)

    // WebGL fica de fora de propósito: cada contexto conta contra o limite de
    // ~16 do Chromium, e um canvas com muitos terminais estoura esse teto.
    // Ligar seletivamente (só o terminal em foco) é trabalho da fase 4.

    try {
      fit.fit()
    } catch {
      /* nó ainda sem tamanho */
    }

    termRef.current = term

    let disposed = false
    void (async () => {
      const result = await window.atelier.terminal.spawn(
        workspaceId,
        node.id,
        term.cols,
        term.rows
      )
      if (disposed) return
      if (result?.error) {
        // Mostra o motivo real: "node-pty indisponível" sozinho não diz nada
        term.writeln('\x1b[31mNão foi possível abrir o terminal.\x1b[0m')
        for (const line of result.error.split('\n')) term.writeln(`\x1b[90m${line}\x1b[0m`)
        term.writeln('')
        term.writeln('\x1b[90mSe for erro de módulo nativo: npm run postinstall\x1b[0m')
        return
      }
      if (result?.buffer) term.write(result.buffer)
    })()

    const offData = window.atelier.terminal.onData(({ id, data }) => {
      if (id === node.id) term.write(data)
    })
    const offExit = window.atelier.terminal.onExit(({ id, code }) => {
      if (id === node.id) term.writeln(`\r\n\x1b[90m[processo encerrado: ${code}]\x1b[0m`)
    })

    const onInput = term.onData((data) => {
      void window.atelier.terminal.write(node.id, data)
    })

    const ro = new ResizeObserver(() => {
      try {
        fit.fit()
        void window.atelier.terminal.resize(node.id, term.cols, term.rows)
      } catch {
        /* durante o resize o nó pode ficar com tamanho zero */
      }
    })
    ro.observe(hostRef.current)

    return () => {
      disposed = true
      ro.disconnect()
      onInput.dispose()
      offData()
      offExit()
      term.dispose()
      termRef.current = null
    }
  }, [frozen, node.id, workspaceId])

  if (frozen) {
    return (
      <div className="terminal-frozen" data-node-interactive={false}>
        <span>{content.name}</span>
        <small>aproxime o zoom para interagir</small>
      </div>
    )
  }

  return <div ref={hostRef} className="terminal-host" data-node-interactive />
}
