/**
 * Normalização da barra de endereço — compartilhada entre o renderer (onde o
 * usuário digita) e o main (onde o agente digita, via `atelier portal open`).
 *
 * Vive em shared/ porque as duas pontas precisam concordar: um agente que
 * escreve `localhost:5173` tem que chegar no mesmo lugar que o usuário.
 */

/** Página inicial de um portal novo e destino da busca. */
export const HOME_URL = 'https://www.google.com'

/** `electron.com` → `https://electron.com`; termo solto → busca. */
export function normalizeURL(input: string): string {
  const raw = input.trim()
  if (!raw) return ''
  // localhost:3000 vem ANTES do teste de esquema: `localhost:` casa com a cara
  // de um scheme, e sem isso o dev server mais comum do mundo não abriria.
  // http, porque em https o servidor local normalmente não responde.
  if (/^localhost(:\d+)?(\/|$)/i.test(raw) || /^127\.0\.0\.1(:\d+)?(\/|$)/.test(raw)) {
    return `http://${raw}`
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return raw
  // Tem cara de domínio: tem ponto e nenhum espaço
  if (/\./.test(raw) && !/\s/.test(raw)) return `https://${raw}`
  return `https://www.google.com/search?q=${encodeURIComponent(raw)}`
}
