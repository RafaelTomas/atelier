/**
 * Nó Terminal — SwiftTerm/PTY vira xterm.js + node-pty.
 *
 * SOBRE ZOOM (risco §4.2 do plano de migração): abaixo de FREEZE_ZOOM o
 * terminal é substituído por um placeholder estático e para de renderizar.
 * Terminal fora da viewport nem chega a ser montado (a virtualização do canvas
 * cuida disso).
 *
 * O outro lado do zoom é a MATEMÁTICA do xterm, e é ela que vive em
 * `unscaleForZoom` aqui embaixo: as medidas de célula saem de um OffscreenCanvas
 * (pixels de CSS, alheios ao `transform` do .nodes-layer), mas as coordenadas do
 * mouse saem de `getBoundingClientRect` (pixels de TELA, já escalados). Misturar
 * as duas faz a seleção apontar para a linha errada em todo zoom ≠ 100%.
 */
import { useEffect, useRef, useState } from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Terminal } from '@xterm/xterm'
import type { CanvasNode, TerminalContent, TerminalTheme, UUID } from '@shared/types'
import { viewport } from '../canvas/viewport'
import { store, useStore } from '../state/store'
import { DEFAULT_FONT_FAMILY, DEFAULT_FONT_SIZE, resolveTheme } from '../terminal-presets'
import '@xterm/xterm/css/xterm.css'

const FREEZE_ZOOM = 0.1

/**
 * Espera antes de repassar o tamanho novo.
 *
 * Um `ResizeObserver` dispara a cada frame do arrasto da alça, e cada `fit`
 * mandava um SIGWINCH ao PTY. TUI nenhuma sobrevive a sessenta redesenhos por
 * segundo: o Claude Code e afins reimprimem a tela por cima da anterior e
 * deixam a parte de baixo pela metade. Só o tamanho FINAL do gesto interessa
 * ao processo do outro lado.
 */
const FIT_DEBOUNCE_MS = 120

type PointLike = { clientX: number; clientY: number }

/** O pedaço do core do xterm que converte mouse em célula. */
interface MouseServiceLike {
  getCoords(
    event: PointLike,
    element: HTMLElement,
    colCount: number,
    rowCount: number,
    isSelection?: boolean
  ): [number, number] | undefined
  getMouseReportCoords(event: PointLike, element: HTMLElement): unknown
}

/**
 * Desfaz o zoom do canvas nas coordenadas que chegam ao xterm.
 *
 * O xterm calcula a célula como `(clientY - rect.top) / cellHeight`. O
 * numerador vem de `getBoundingClientRect`, que o `transform: scale()` da
 * .nodes-layer já multiplicou pelo zoom; o denominador vem da medição por
 * OffscreenCanvas, que ignora transform. A conta erra por um fator igual ao
 * zoom, e o erro CRESCE com a distância do topo — daí a seleção pegar a linha
 * de cima ou de baixo, cada vez mais longe quanto mais para o fim da tela.
 *
 * Corrigir a divisão exigiria mexer no tamanho de célula, que é o mesmo número
 * usado para desenhar. Então o ajuste vai no ponto: o evento é reescrito para a
 * posição que ele teria se o nó estivesse em 100%, mantendo a âncora do rect.
 * Nada além do mouse muda, e em zoom 1 a função devolve o próprio evento.
 */
function unscaleForZoom(event: PointLike, element: HTMLElement): PointLike {
  const zoom = viewport.zoom
  if (zoom === 1) return event
  const rect = element.getBoundingClientRect()
  return {
    clientX: rect.left + (event.clientX - rect.left) / zoom,
    clientY: rect.top + (event.clientY - rect.top) / zoom
  }
}

/**
 * Envolve o serviço de mouse do core recém-aberto.
 *
 * É API privada (o próprio FitAddon depende de `_core`), então tudo falha em
 * silêncio: sem o serviço, o terminal continua funcionando com a seleção que já
 * tinha — não vale derrubar o nó por causa disso.
 */
function patchMouseForZoom(term: Terminal): void {
  const mouse = (term as unknown as { _core?: { _mouseService?: MouseServiceLike } })._core
    ?._mouseService
  if (!mouse) return
  const coords = mouse.getCoords.bind(mouse)
  const report = mouse.getMouseReportCoords.bind(mouse)
  mouse.getCoords = (event, element, colCount, rowCount, isSelection) =>
    coords(unscaleForZoom(event, element), element, colCount, rowCount, isSelection)
  mouse.getMouseReportCoords = (event, element) => report(unscaleForZoom(event, element), element)
}

interface Props {
  node: CanvasNode
  content: TerminalContent
  workspaceId: UUID
  /** Temas personalizados do usuário; os embutidos são resolvidos sozinhos. */
  customThemes?: TerminalTheme[]
}

export function TerminalNode({
  node,
  content,
  workspaceId,
  customThemes = []
}: Props): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const [frozen, setFrozen] = useState(viewport.zoom < FREEZE_ZOOM)
  const { theme, terminalEpoch } = useStore()
  /** Sobe a cada recarregar: derruba o xterm e faz o PTY nascer de novo. */
  const epoch = terminalEpoch[node.id] ?? 0

  useEffect(() => viewport.subscribe((v) => setFrozen(v.zoom < FREEZE_ZOOM)), [])

  // Troca de tema com o terminal já montado: repinta sem recriar o PTY.
  // No modo 'system' o valor da store não muda quando o SO alterna, então o
  // media query é ouvido também — senão o terminal ficaria com a cor antiga.
  // Terminal com tema próprio não se mexe: resolveTheme devolve a cor fixa.
  useEffect(() => {
    const repaint = (): void => {
      if (!termRef.current) return
      const next = resolveTheme(content.themeId, customThemes)
      termRef.current.options.theme = {
        background: next.background,
        foreground: next.foreground,
        cursor: next.foreground
      }
    }
    repaint()
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    mq.addEventListener('change', repaint)
    return () => mq.removeEventListener('change', repaint)
  }, [theme, content.themeId, customThemes])

  useEffect(() => {
    if (frozen || !hostRef.current || termRef.current) return

    const palette = resolveTheme(content.themeId, customThemes)
    const term = new Terminal({
      fontFamily: content.fontFamily ?? DEFAULT_FONT_FAMILY,
      fontSize: content.fontSize ?? DEFAULT_FONT_SIZE,
      cursorBlink: true,
      allowProposedApi: true,
      theme: {
        background: palette.background,
        foreground: palette.foreground,
        cursor: palette.foreground
      },
      scrollback: 5000
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    // Link na saída do terminal abre num Portal do próprio Atelier, não no
    // navegador do sistema — o handler custom troca o comportamento padrão do
    // addon (que seria window.open, negado por setWindowOpenHandler).
    term.loadAddon(
      new WebLinksAddon((_event, uri) => {
        void window.atelier.terminal.openLink(node.id, uri)
      })
    )
    const host = hostRef.current
    term.open(host)
    // Depois do open: os serviços do core (o de mouse entre eles) só existem
    // quando o terminal tem elemento.
    patchMouseForZoom(term)

    // Colar imagem: o xterm só trata texto. Interceptamos em CAPTURA no
    // documento (garantido antes do textarea escondido do xterm, esteja ele
    // onde estiver na árvore) e mandamos os bytes para o main, que grava um
    // arquivo temporário e cola o CAMINHO na linha — é assim que o Claude Code
    // recebe imagem. Sem imagem no clipboard, o xterm segue com o texto.
    const onPaste = (e: ClipboardEvent): void => {
      const target = e.target as Node | null
      if (!target || !host.contains(target)) return

      const data = e.clipboardData
      const fromItems = [...(data?.items ?? [])]
        .filter((i) => i.kind === 'file' && i.type.startsWith('image/'))
        .map((i) => i.getAsFile())
        .find((f): f is File => f != null)
      const file =
        fromItems ?? [...(data?.files ?? [])].find((f) => f.type.startsWith('image/'))
      if (!file) return

      e.preventDefault()
      e.stopImmediatePropagation()
      void file
        .arrayBuffer()
        .then((buf) => window.atelier.terminal.pasteImage(node.id, buf, file.type))
        .then((r) => {
          if (r && 'error' in r) store.showNotice(r.error)
        })
        .catch((err: unknown) => {
          store.showNotice(`falha ao colar a imagem: ${(err as Error).message}`)
        })
    }
    document.addEventListener('paste', onPaste, true)

    // WebGL fica de fora de propósito: cada contexto conta contra o limite de
    // ~16 do Chromium, e um canvas com muitos terminais estoura esse teto.
    // Ligar seletivamente (só o terminal em foco) é trabalho da fase 4.

    /**
     * Ajusta as colunas/linhas ao tamanho do nó e conta ao PTY.
     *
     * Uma função só, usada pelo primeiro ajuste e por todos os seguintes: o
     * tamanho do xterm e o do processo do outro lado precisam ser SEMPRE o
     * mesmo par de números. Quando divergem, o programa desenha para uma tela
     * que não existe — mais linhas do que caibam é a metade de baixo faltando.
     */
    const fitNow = (): void => {
      try {
        fit.fit()
        void window.atelier.terminal.resize(node.id, term.cols, term.rows)
      } catch {
        /* nó ainda sem tamanho, ou já descartado */
      }
    }

    let fitTimer: number | null = null
    const fitSoon = (): void => {
      if (fitTimer !== null) clearTimeout(fitTimer)
      fitTimer = window.setTimeout(() => {
        fitTimer = null
        fitNow()
      }, FIT_DEBOUNCE_MS)
    }

    try {
      fit.fit()
    } catch {
      /* nó ainda sem tamanho */
    }

    /**
     * A fonte do terminal pode chegar DEPOIS do primeiro ajuste.
     *
     * Até ela carregar, o xterm mede a célula na fonte de fallback — célula
     * mais estreita ou mais baixa, e portanto um número de linhas que não é o
     * que cabe. Quando a fonte real assenta, o xterm remede e redesenha, mas
     * `cols/rows` continuam os antigos e o `ResizeObserver` não acorda (o nó não
     * mudou de tamanho): o terminal fica com a parte de baixo fora da caixa até
     * alguém redimensionar o nó na mão. Um reajuste depois de `fonts.ready`
     * fecha essa janela.
     */
    void document.fonts.ready.then(() => {
      if (termRef.current === term) fitNow()
    })

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
      // Reabrir a janela não gera saída nova: sem isto o rodapé só apareceria
      // no próximo chunk do agente.
      if (result?.status) store.setTerminalStatus(node.id, result.status)
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

    // Debounced: ver FIT_DEBOUNCE_MS. Durante o arrasto da alça o nó também
    // passa por tamanhos absurdos (inclusive zero), e nenhum deles merece uma
    // ida ao PTY.
    const ro = new ResizeObserver(fitSoon)
    ro.observe(host)

    return () => {
      disposed = true
      if (fitTimer !== null) clearTimeout(fitTimer)
      document.removeEventListener('paste', onPaste, true)
      ro.disconnect()
      onInput.dispose()
      offData()
      offExit()
      term.dispose()
      termRef.current = null
    }
  }, [frozen, node.id, workspaceId, epoch])

  const palette = resolveTheme(content.themeId, customThemes)

  if (frozen) {
    return (
      <div
        className="terminal-frozen"
        data-node-interactive={false}
        style={{ background: palette.background }}
      >
        <span>{content.name}</span>
        <small>aproxime o zoom para interagir</small>
      </div>
    )
  }

  return (
    <div
      ref={hostRef}
      className="terminal-host"
      data-node-interactive
      style={{ background: palette.background }}
    />
  )
}
