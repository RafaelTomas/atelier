/**
 * Extensão de arquivo → modo do CodeMirror.
 *
 * Os carregadores são DINÂMICOS de propósito: importar as treze gramáticas de
 * forma estática colaria todas no bundle do renderer, mesmo num canvas que só
 * abriu um `.md`. Assim o Vite fatia cada uma num chunk e a linguagem chega
 * quando o primeiro arquivo daquele tipo for aberto.
 *
 * A lista cobre o que aparece no índice de projetos de verdade. Extensão fora
 * dela não é erro: o arquivo abre em texto puro, sem destaque.
 */
import type { LanguageSupport } from '@codemirror/language'

type Loader = () => Promise<LanguageSupport>

const BY_EXTENSION: Record<string, Loader> = {
  // JavaScript e parentes — o mesmo pacote, com dialetos diferentes
  js: async () => (await import('@codemirror/lang-javascript')).javascript(),
  mjs: async () => (await import('@codemirror/lang-javascript')).javascript(),
  cjs: async () => (await import('@codemirror/lang-javascript')).javascript(),
  jsx: async () => (await import('@codemirror/lang-javascript')).javascript({ jsx: true }),
  ts: async () => (await import('@codemirror/lang-javascript')).javascript({ typescript: true }),
  mts: async () => (await import('@codemirror/lang-javascript')).javascript({ typescript: true }),
  cts: async () => (await import('@codemirror/lang-javascript')).javascript({ typescript: true }),
  tsx: async () =>
    (await import('@codemirror/lang-javascript')).javascript({ typescript: true, jsx: true }),

  py: async () => (await import('@codemirror/lang-python')).python(),
  pyi: async () => (await import('@codemirror/lang-python')).python(),

  json: async () => (await import('@codemirror/lang-json')).json(),
  jsonc: async () => (await import('@codemirror/lang-json')).json(),

  md: async () => (await import('@codemirror/lang-markdown')).markdown(),
  markdown: async () => (await import('@codemirror/lang-markdown')).markdown(),

  html: async () => (await import('@codemirror/lang-html')).html(),
  htm: async () => (await import('@codemirror/lang-html')).html(),

  css: async () => (await import('@codemirror/lang-css')).css(),
  scss: async () => (await import('@codemirror/lang-css')).css(),

  java: async () => (await import('@codemirror/lang-java')).java(),
  sql: async () => (await import('@codemirror/lang-sql')).sql(),

  xml: async () => (await import('@codemirror/lang-xml')).xml(),
  svg: async () => (await import('@codemirror/lang-xml')).xml(),
  plist: async () => (await import('@codemirror/lang-xml')).xml(),

  yaml: async () => (await import('@codemirror/lang-yaml')).yaml(),
  yml: async () => (await import('@codemirror/lang-yaml')).yaml(),

  rs: async () => (await import('@codemirror/lang-rust')).rust(),
  php: async () => (await import('@codemirror/lang-php')).php(),

  c: async () => (await import('@codemirror/lang-cpp')).cpp(),
  h: async () => (await import('@codemirror/lang-cpp')).cpp(),
  cc: async () => (await import('@codemirror/lang-cpp')).cpp(),
  hh: async () => (await import('@codemirror/lang-cpp')).cpp(),
  cpp: async () => (await import('@codemirror/lang-cpp')).cpp(),
  hpp: async () => (await import('@codemirror/lang-cpp')).cpp(),
  cxx: async () => (await import('@codemirror/lang-cpp')).cpp()
}

/**
 * Alguns arquivos não têm extensão e mesmo assim têm linguagem óbvia. O nome
 * inteiro é consultado antes da extensão.
 */
const BY_NAME: Record<string, Loader> = {
  Dockerfile: BY_EXTENSION.yaml,
  Makefile: BY_EXTENSION.yaml,
  '.babelrc': BY_EXTENSION.json,
  '.eslintrc': BY_EXTENSION.json,
  '.prettierrc': BY_EXTENSION.json
}

/** null = sem destaque, o arquivo abre como texto puro. */
export function languageLoaderFor(path: string): Loader | null {
  const name = path.split(/[\\/]/).pop() ?? ''
  if (BY_NAME[name]) return BY_NAME[name]
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return null
  return BY_EXTENSION[name.slice(dot + 1).toLowerCase()] ?? null
}

/** `.md` / `.markdown` — os que o nó abre em modo prévia por padrão. */
export function isMarkdownPath(path: string): boolean {
  return /\.(md|markdown|mdown|mkd)$/i.test(path)
}

/** Último componente do caminho. O renderer não tem `path`, e o Windows usa `\`. */
export function fileNameOf(path: string): string {
  return path.split(/[\\/]/).pop() ?? path
}
