/**
 * Tipagem do <webview> do Electron para o JSX.
 *
 * O React não conhece essa tag (ela vem do Chromium, habilitada por
 * `webviewTag: true` em window.ts), então sem isso o TS reclama de elemento
 * intrínseco desconhecido. Só os atributos que o PortalNode usa estão aqui.
 */
import type { DetailedHTMLProps, HTMLAttributes } from 'react'

interface WebviewAttributes extends HTMLAttributes<HTMLElement> {
  src?: string
  partition?: string
  useragent?: string
  preload?: string
  httpreferrer?: string
  /** `webpreferences="key=value,..."` — string, não objeto. */
  webpreferences?: string
}

declare global {
  namespace JSX {
    interface IntrinsicElements {
      webview: DetailedHTMLProps<WebviewAttributes, HTMLElement>
    }
  }
}

export {}
