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
  // Caminho de arquivo ANTES do teste de esquema: `C:\notas\x.html` casa com a
  // cara de um scheme, e `/home/eu/x.html` tem ponto e nenhum espaço — sem isto
  // um arquivo local colado na barra virava `https://` e nunca abria.
  if (isFilePath(raw)) return toFileURL(raw)
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return raw
  // `//cdn.exemplo.com/x.js`: URL protocol-relative, do jeito que sai ao copiar
  // de um HTML. Só falta o esquema — e cair no ramo de domínio abaixo daria
  // `https:////cdn…`, que não abre. Defeito antigo, achado ao cobrir a função
  // com teste; o ramo de caminho de arquivo acima já exige UMA barra por isto.
  if (/^\/\//.test(raw)) return `https:${raw}`
  // Tem cara de domínio: tem ponto e nenhum espaço
  if (/\./.test(raw) && !/\s/.test(raw)) return `https://${raw}`
  return `https://www.google.com/search?q=${encodeURIComponent(raw)}`
}

/** `/home/eu/x.html`, `C:\notas\x.html`, `\\servidor\share\x.html`. */
function isFilePath(raw: string): boolean {
  return /^\/(?!\/)/.test(raw) || /^[a-zA-Z]:[\\/]/.test(raw) || /^\\\\/.test(raw)
}

/**
 * Caminho do disco → `file://`. Cada segmento é escapado por conta própria: um
 * `#` ou um espaço no nome do arquivo cortaria a URL ao meio se fosse cru.
 */
function toFileURL(raw: string): string {
  const drive = /^[a-zA-Z]:[\\/]/.test(raw)
  const path = raw.replace(/\\/g, '/')
  // O `:` da unidade é estrutura, não nome: `C:` escapado vira `C%3A` e o
  // Chromium desiste do arquivo.
  const encoded = path
    .split('/')
    .map((seg, i) => (drive && i === 0 ? seg : encodeURIComponent(seg)))
    .join('/')
  // UNC (`//servidor/share`) já traz o host nas duas barras; o resto é local.
  if (encoded.startsWith('//')) return `file:${encoded}`
  return drive ? `file:///${encoded}` : `file://${encoded}`
}
