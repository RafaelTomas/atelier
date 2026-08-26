/**
 * Nó Portal — navegador embutido no canvas.
 *
 * POR QUE <webview> E NÃO WebContentsView (README §"Por que Portal ainda não
 * existe"): as views nativas são compostas POR CIMA da página, ignorando
 * `transform`, `z-index` e recorte — num canvas com pan/zoom ficariam sempre
 * no lugar errado. O <webview> é um elemento do DOM de verdade: herda o
 * transform do .nodes-layer, respeita o overflow do nó e entra no mesmo
 * empilhamento dos outros nós. É a saída que o README previa.
 *
 * ZOOM (mesma mitigação do TerminalNode): abaixo de FREEZE_ZOOM o webview é
 * desmontado e dá lugar a um cartão estático. Isso evita manter N processos de
 * renderização vivos num canvas afastado — e nó fora da viewport nem monta,
 * porque a virtualização do canvas cuida disso.
 */
import { useEffect, useRef, useState } from 'react'
import type { CanvasNode, PortalContent, UUID } from '@shared/types'
import { portalPartition } from '@shared/types'
import { HOME_URL, normalizeURL } from '@shared/portal-url'
import { viewport } from '../canvas/viewport'
import { portalWake } from '../state/portal-wake'
// Reexportados: o dock importa HOME_URL daqui desde antes de shared/portal-url
export { HOME_URL, normalizeURL } from '@shared/portal-url'
import { store } from '../state/store'

const FREEZE_ZOOM = 0.1

interface Props {
  node: CanvasNode
  content: PortalContent
  workspaceId: UUID
}

/**
 * Rótulo curto: o host sem `www.` — ou o nome do arquivo, quando o portal está
 * mostrando um documento local (`file://`), onde host é string vazia.
 */
function hostLabel(url: string): string {
  try {
    const parsed = new URL(url)
    if (parsed.protocol === 'file:') {
      return decodeURIComponent(parsed.pathname.split('/').pop() || url)
    }
    return parsed.host.replace(/^www\./, '')
  } catch {
    return url
  }
}

/**
 * Título do nó. Prefere o host à URL inteira e ao nome: com vários portais
 * abertos, "Portal / Portal / Portal" não diz nada, "google.com / github.com" diz.
 * Um nome definido pelo usuário (≠ 'Portal') sempre ganha.
 */
export function portalLabel(content: PortalContent): string {
  if (content.name && content.name !== 'Portal') return content.name
  return content.currentURL ? hostLabel(content.currentURL) : 'Portal'
}

type WebviewEl = HTMLElement & {
  src: string
  getURL(): string
  /** Só válido depois do `dom-ready`: antes disso o guest não está anexado. */
  getWebContentsId(): number
  canGoBack(): boolean
  canGoForward(): boolean
  goBack(): void
  goForward(): void
  reload(): void
  stop(): void
}

export function PortalNode({ node, content, workspaceId }: Props): JSX.Element {
  const viewRef = useRef<WebviewEl | null>(null)
  // Acordado pelo agente: monta o webview mesmo com o zoom no fundo. É o mesmo
  // motivo do TerminalNode continuar vivo — só que aqui quem precisa do nó de pé
  // é quem está lendo a página, não quem está olhando.
  const [awake, setAwake] = useState(portalWake.has(node.id))
  const [frozen, setFrozen] = useState(viewport.zoom < FREEZE_ZOOM)
  const [draft, setDraft] = useState(content.currentURL)
  const [editing, setEditing] = useState(false)
  const [loading, setLoading] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [nav, setNav] = useState({ back: false, forward: false })

  useEffect(() => viewport.subscribe((v) => setFrozen(v.zoom < FREEZE_ZOOM)), [])
  useEffect(() => portalWake.subscribe(() => setAwake(portalWake.has(node.id))), [node.id])

  /** Congelado pelo zoom, mas não se o agente pediu para ler agora. */
  const asleep = frozen && !awake

  // A URL pode mudar por fora (patchContent vindo do CLI ou de outra sessão).
  useEffect(() => {
    if (!editing) setDraft(content.currentURL)
  }, [content.currentURL, editing])

  // ─── Eventos do webview ─────────────────────────────────────────────────────

  useEffect(() => {
    const el = viewRef.current
    if (asleep || !el) return

    const syncNav = (): void => {
      setNav({ back: el.canGoBack(), forward: el.canGoForward() })
    }

    const onStart = (): void => {
      setLoading(true)
      setFailure(null)
    }

    const onStop = (): void => {
      setLoading(false)
      syncNav()
    }

    /** Só a navegação concluída é persistida — assim o nó reabre onde parou. */
    const onNavigated = (e: Event): void => {
      const url = (e as Event & { url?: string }).url ?? el.getURL()
      if (!url || url === content.currentURL) return
      setDraft(url)
      void store.patchContent(node.id, { currentURL: url, source: { kind: 'url', url } })
    }

    const onFail = (e: Event): void => {
      const { errorCode, errorDescription, isMainFrame } = e as Event & {
        errorCode?: number
        errorDescription?: string
        isMainFrame?: boolean
      }
      setLoading(false)
      // -3 = ABORTED: navegação cancelada pelo usuário, não é erro de verdade.
      if (isMainFrame === false || errorCode === -3) return
      setFailure(errorDescription || `falha ao carregar (${errorCode ?? '?'})`)
    }

    /**
     * O main precisa saber com qual webContents este nó fala — é o que permite
     * tratar popup, ler a página e tirar captura (core/portal/portal-registry.ts).
     * `dom-ready` é o primeiro momento em que `getWebContentsId()` responde, e
     * ele dispara de novo a cada navegação: o registro é idempotente.
     */
    const onReady = (): void => {
      try {
        void window.atelier.portal.register(node.id, el.getWebContentsId())
      } catch {
        // webview desanexado no meio do caminho — o unmount já cuida do resto
      }
    }

    el.addEventListener('dom-ready', onReady)
    el.addEventListener('did-start-loading', onStart)
    el.addEventListener('did-stop-loading', onStop)
    el.addEventListener('did-navigate', onNavigated)
    el.addEventListener('did-navigate-in-page', onNavigated)
    el.addEventListener('did-fail-load', onFail)

    return () => {
      void window.atelier.portal.unregister(node.id)
      el.removeEventListener('dom-ready', onReady)
      el.removeEventListener('did-start-loading', onStart)
      el.removeEventListener('did-stop-loading', onStop)
      el.removeEventListener('did-navigate', onNavigated)
      el.removeEventListener('did-navigate-in-page', onNavigated)
      el.removeEventListener('did-fail-load', onFail)
    }
  }, [asleep, node.id, content.currentURL])

  // ─── Ações ──────────────────────────────────────────────────────────────────

  const go = (value: string): void => {
    const url = normalizeURL(value)
    if (!url) return
    setEditing(false)
    setFailure(null)
    setDraft(url)
    // Escreve o conteúdo mesmo se o webview estiver congelado: ao voltar o zoom
    // ele monta já com o src certo.
    void store.patchContent(node.id, { currentURL: url, source: { kind: 'url', url } })
    if (viewRef.current) viewRef.current.src = url
  }

  if (asleep) {
    return (
      <div className="portal-frozen">
        <span>{content.currentURL ? hostLabel(content.currentURL) : content.name}</span>
        <small>aproxime o zoom para navegar</small>
      </div>
    )
  }

  return (
    <div className="portal-node" data-node-interactive>
      {!content.chromeHidden && (
        <div className="portal-chrome">
          <button
            type="button"
            className="icon-btn portal-btn"
            title="Voltar"
            disabled={!nav.back}
            onClick={() => viewRef.current?.goBack()}
          >
            ‹
          </button>
          <button
            type="button"
            className="icon-btn portal-btn"
            title="Avançar"
            disabled={!nav.forward}
            onClick={() => viewRef.current?.goForward()}
          >
            ›
          </button>
          <button
            type="button"
            className="icon-btn portal-btn"
            title={loading ? 'Parar' : 'Recarregar'}
            onClick={() => (loading ? viewRef.current?.stop() : viewRef.current?.reload())}
          >
            {loading ? '×' : '⟳'}
          </button>

          <button
            type="button"
            className="icon-btn portal-btn"
            title="Página inicial"
            onClick={() => go(HOME_URL)}
          >
            ⌂
          </button>

          <input
            className="portal-url"
            spellCheck={false}
            placeholder="url ou busca…"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onFocus={() => setEditing(true)}
            onBlur={() => {
              setEditing(false)
              setDraft(content.currentURL)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') go(draft)
              if (e.key === 'Escape') {
                setDraft(content.currentURL)
                ;(e.target as HTMLInputElement).blur()
              }
            }}
          />

          <button
            type="button"
            className="icon-btn portal-btn"
            title="Abrir no navegador do sistema"
            disabled={!content.currentURL}
            onClick={() => void window.atelier.portal.openExternal(content.currentURL)}
          >
            ↗
          </button>
        </div>
      )}

      {content.currentURL ? (
        <div className="portal-viewport">
          {/* `partition` isola cookies/sessão por nó — e um popup herda a do
              pai, senão nasceria deslogado (portalPartition, em shared/types).
              Continua sem `allowpopups`: quem trata window.open é o main, no
              setWindowOpenHandler armado sobre o guest deste webview
              (core/portal/portal-popup.ts). Uma janela nativa solta dentro do
              app nunca é a resposta certa aqui. */}
          <webview
            ref={(el) => (viewRef.current = el as WebviewEl | null)}
            src={content.currentURL}
            partition={portalPartition(content)}
          />
          {failure && (
            <div className="portal-error">
              <strong>não carregou</strong>
              <span>{failure}</span>
              <button type="button" onClick={() => viewRef.current?.reload()}>
                tentar de novo
              </button>
            </div>
          )}
        </div>
      ) : (
        <div className="portal-empty">
          <strong>Portal</strong>
          <span>digite uma URL acima para começar</span>
        </div>
      )}
    </div>
  )
}
