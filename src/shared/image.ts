/**
 * Helpers de imagem compartilhados entre main, preload e renderer.
 *
 * Um lugar só para o mapa mime ⇄ extensão (o nó grava a extensão no fileName, o
 * `image:read` deriva o mime de volta) e para a leitura do tamanho de um PNG
 * pelo header — sem dependência de nenhuma API de imagem.
 */

const EXT_FOR_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/svg+xml': 'svg',
  'image/bmp': 'bmp'
}

const MIME_FOR_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  svg: 'image/svg+xml',
  bmp: 'image/bmp'
}

/** Extensão de arquivo para um mime de imagem — `png` como padrão seguro. */
export function extForImageMime(mime: string): string {
  return EXT_FOR_MIME[mime] ?? 'png'
}

/** Mime a partir da extensão de um nome de arquivo — `image/png` como padrão. */
export function mimeForImageName(fileName: string): string {
  const ext = fileName.slice(fileName.lastIndexOf('.') + 1).toLowerCase()
  return MIME_FOR_EXT[ext] ?? 'image/png'
}

/** true se a extensão do arquivo é uma das que o nó de imagem aceita. */
export function isSupportedImageName(fileName: string): boolean {
  const ext = fileName.slice(fileName.lastIndexOf('.') + 1).toLowerCase()
  return ext in MIME_FOR_EXT
}

/**
 * Largura/altura de um PNG lidas do header IHDR (bytes 16–24). Só PNG: é o
 * formato de quase toda saída de ferramenta de gráfico e de screenshot; para o
 * resto o chamador usa 0 e deixa o renderer dimensionar.
 */
export function pngDimensions(
  bytes: Uint8Array
): { width: number; height: number } | null {
  const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  if (bytes.length < 24) return null
  for (let i = 0; i < 8; i++) if (bytes[i] !== SIG[i]) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return { width: view.getUint32(16), height: view.getUint32(20) }
}
