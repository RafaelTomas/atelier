/**
 * Busca na árvore: por nome e por conteúdo.
 *
 * As duas percorrem a MESMA caminhada, com a mesma poda e os mesmos tetos, por
 * isso moram juntas. O que muda é só o que cada uma faz com o arquivo que
 * encontrou: uma olha o nome, a outra abre e lê.
 *
 * Três decisões que não são detalhe:
 *
 *   1. **Sem `rg`, sem `git grep`.** Nenhum ripgrep é distribuído com o app, e
 *      depender de um instalado na máquina faz a busca existir em uns
 *      computadores e não em outros — a pior forma de uma feature falhar. E
 *      `git grep` só vê o que está rastreado: um arquivo novo, ainda não
 *      adicionado, é justamente o que se está procurando na maior parte das
 *      vezes. Então a varredura é em Node, aqui, igual nos três sistemas.
 *
 *   2. **A poda desta busca NÃO é a `DEFAULT_EXCLUDED_DIRS` do scanner.** A
 *      lista de lá foi medida para varrer a HOME atrás de projetos, e corta
 *      `packages`, `bin`, `env`, `vendor` — que dentro de um projeto é
 *      exatamente onde o código mora (`packages/` de um monorepo). Reusar a
 *      lista faria a busca não achar o que está na cara do usuário. A lista
 *      daqui é curta e só tem o que nunca é fonte de trabalho.
 *
 *   3. **Todo teto devolve o motivo.** Uma busca que para no meio e não diz que
 *      parou mente: o usuário lê "3 resultados" e conclui que há três. Por isso
 *      `stopped` sobe até a UI, e a UI escreve isso na tela.
 */
import { type Dirent } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import type {
  FileSearchContentResult,
  FileSearchHit,
  FileSearchNamesResult,
  FileSearchOptions,
  FsEntry
} from '@shared/types'
import { MAX_TEXT_BYTES } from './file-ops'

/**
 * Diretórios que a busca não desce.
 *
 * Só dependência instalada, artefato de build e metadado de ferramenta — nada
 * que alguém escreva à mão. `.git` está aqui pela mesma razão que está na
 * listagem: são milhares de objetos internos, e ninguém procura neles.
 *
 * Note o que NÃO está: `packages`, `vendor`, `bin`, `src`, nem "tudo que começa
 * com ponto". Um `.github/workflows/ci.yml` é trabalho do usuário como qualquer
 * outro arquivo, e uma busca que o esconde é uma busca em que não se confia.
 */
const SKIPPED_DIRS: ReadonlySet<string> = new Set([
  '.git',
  'node_modules',
  'bower_components',
  '__pycache__',
  '.mypy_cache',
  '.pytest_cache',
  '.ruff_cache',
  '.venv',
  'venv',
  '.tox',
  '.gradle',
  '.next',
  '.nuxt',
  '.turbo',
  '.svelte-kit',
  '.output',
  '.parcel-cache',
  '.cache',
  'dist',
  'build',
  'out',
  'coverage',
  'DerivedData',
  '__MACOSX'
])

/** Diretórios visitados. Um projeto com mais que isto não é mais um projeto. */
const MAX_DIRS = 20_000
/** Arquivos considerados. Além disto a busca para e diz que parou. */
const MAX_FILES = 50_000
/** Casamentos por arquivo. O resto vira "… mais N" na linha do arquivo. */
const MAX_HITS_PER_FILE = 50
/** Arquivos com casamento. Uma lista maior que isto ninguém lê. */
const MAX_FILES_WITH_HITS = 300
/** Casamentos no total. É o teto que existe para o IPC, que clona tudo. */
const MAX_TOTAL_HITS = 2_000
/** Nomes casados devolvidos. A árvore filtrada acima disto deixa de ser árvore. */
const MAX_NAME_HITS = 500
/** Trecho da linha. Linha de 40 KB de um bundle não cabe na tela nem no IPC. */
const MAX_LINE_CHARS = 400
/**
 * Orçamento de tempo. Buscar é síncrono para quem espera: passado isto, meio
 * resultado com aviso vale mais do que a janela parada.
 */
const TIME_BUDGET_MS = 6_000
/** Só o começo decide se é binário — o mesmo critério do `readTextFile`. */
const SNIFF_BYTES = 8 * 1024

/** Por que a varredura parou antes do fim, ou null quando varreu tudo. */
export type SearchStop = 'results' | 'files' | 'time' | null

/**
 * Monta o casador a partir das opções, ou devolve null quando a expressão do
 * usuário não compila — digitar `(` num campo de regex é normal, e derrubar a
 * busca por isso não é.
 */
function buildMatcher(options: FileSearchOptions): RegExp | null {
  const { query, regex, wholeWord, caseSensitive } = options
  const flags = caseSensitive ? 'g' : 'gi'
  const source = regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // `\b` só funciona na borda de caractere de palavra: com um termo que começa
  // em símbolo (`--force`, `#id`) a âncora nunca casaria. Nesse caso "palavra
  // inteira" não quer dizer nada, então a opção é ignorada em vez de zerar o
  // resultado sem explicação.
  const anchored =
    wholeWord && /^\w/.test(source.replace(/\\/g, '')) ? `\\b${source}\\b` : source
  try {
    return new RegExp(anchored, flags)
  } catch {
    return null
  }
}

interface Budget {
  deadline: number
  dirs: number
  files: number
}

function overBudget(budget: Budget): SearchStop {
  if (Date.now() > budget.deadline) return 'time'
  if (budget.files > MAX_FILES || budget.dirs > MAX_DIRS) return 'files'
  return null
}

/**
 * Caminha a árvore chamando `visit` em cada arquivo, em largura.
 *
 * Largura e não profundidade de propósito: o que interessa ao usuário está
 * quase sempre nos primeiros níveis, e é onde o orçamento de tempo é gasto
 * primeiro. Uma varredura em profundidade queimaria os 6 segundos dentro do
 * primeiro galho fundo e voltaria sem tocar no resto do projeto.
 *
 * `visit` devolve `false` para pedir parada — é como os tetos de resultado
 * interrompem a caminhada sem precisar de exceção.
 */
async function walk(
  root: string,
  budget: Budget,
  visit: (entry: FsEntry) => boolean | Promise<boolean>
): Promise<SearchStop> {
  const queue: string[] = [root]

  while (queue.length > 0) {
    const stop = overBudget(budget)
    if (stop) return stop

    const dir = queue.shift() as string
    budget.dirs++

    let raw: Dirent[]
    try {
      raw = await readdir(dir, { withFileTypes: true })
    } catch {
      // Pasta sem permissão ou apagada no meio da busca: pula, não aborta. Uma
      // busca que morre no primeiro `EACCES` é inútil em qualquer máquina real.
      continue
    }

    // Pastas por último na fila, arquivos visitados já: assim o nível corrente
    // sai inteiro antes de descer, que é o que "em largura" significa aqui.
    const dirs: string[] = []
    for (const item of raw) {
      const path = join(dir, item.name)
      if (item.isDirectory()) {
        if (SKIPPED_DIRS.has(item.name)) continue
        dirs.push(path)
        if (!(await visit({ name: item.name, path, isDirectory: true, isSymlink: false }))) {
          return null
        }
        continue
      }
      // Symlink não é seguido: um link para o pai fecha um ciclo, e a
      // caminhada nunca termina. O nome continua sendo procurado.
      if (item.isSymbolicLink()) {
        if (!(await visit({ name: item.name, path, isDirectory: false, isSymlink: true }))) {
          return null
        }
        continue
      }
      if (!item.isFile()) continue
      budget.files++
      if (!(await visit({ name: item.name, path, isDirectory: false, isSymlink: false }))) {
        return null
      }
    }
    queue.push(...dirs)
  }

  return null
}

/**
 * Nomes que casam, arquivo e pasta.
 *
 * Casa contra o NOME quando o termo não tem separador, e contra o caminho
 * relativo à raiz quando tem — assim `state/store` acha
 * `src/renderer/state/store.ts`, que é como qualquer um digita o que já sabe
 * onde está.
 */
export async function searchFileNames(
  root: string,
  options: FileSearchOptions
): Promise<FileSearchNamesResult | { error: 'bad-regex' }> {
  const matcher = buildMatcher(options)
  if (!matcher) return { error: 'bad-regex' }

  const byPath = options.query.includes('/') || options.query.includes('\\')
  const entries: FsEntry[] = []
  const budget: Budget = { deadline: Date.now() + TIME_BUDGET_MS, dirs: 0, files: 0 }
  let stop: SearchStop = null

  const walked = await walk(root, budget, (entry) => {
    // `lastIndex` é estado do próprio regex quando a flag `g` está ligada: sem
    // zerar, o segundo `test` começa depois do casamento do primeiro e pula
    // arquivos válidos. É o bug clássico de reusar um regex global.
    matcher.lastIndex = 0
    const subject = byPath ? relative(root, entry.path).split(sep).join('/') : entry.name
    if (!matcher.test(subject)) return true
    entries.push(entry)
    if (entries.length >= MAX_NAME_HITS) {
      stop = 'results'
      return false
    }
    return true
  })

  return { entries, stopped: stop ?? walked }
}

/** Onde o casamento ficou depois de a linha ser cortada no teto. */
interface ClippedLine {
  text: string
  column: number
  length: number
}

/** Corta a linha no teto sem perder o casamento, e diz onde ele ficou. */
function clipLine(text: string, from: number, length: number): ClippedLine {
  if (text.length <= MAX_LINE_CHARS) return { text, column: from, length }
  // Uma janela em volta do casamento, não os primeiros 400 caracteres: num
  // arquivo minificado o casamento está sempre longe do começo, e cortar pela
  // esquerda devolveria um trecho que não mostra o que se procurou.
  const start = Math.max(0, from - Math.floor(MAX_LINE_CHARS / 4))
  const slice = text.slice(start, start + MAX_LINE_CHARS)
  return { text: slice, column: from - start, length: Math.min(length, slice.length) }
}

/** Casamentos de uma linha só, já com o teto por arquivo respeitado. */
function hitsInLine(matcher: RegExp, line: number, text: string, room: number): FileSearchHit[] {
  const hits: FileSearchHit[] = []
  matcher.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = matcher.exec(text)) !== null) {
    const clipped = clipLine(text, match.index, match[0].length)
    hits.push({ line, text: clipped.text, column: clipped.column, length: clipped.length })
    // Casamento vazio (`a*`, `^`) não move o cursor: sem este passo o `exec`
    // devolve o mesmo índice para sempre e a busca nunca volta.
    if (match[0].length === 0) matcher.lastIndex++
    if (hits.length >= room) break
  }
  return hits
}

/** Lê o arquivo como texto, ou devolve null quando não é texto de trabalho. */
async function readSearchable(path: string): Promise<string | null> {
  try {
    const info = await stat(path)
    if (!info.isFile() || info.size === 0 || info.size > MAX_TEXT_BYTES) return null
    const buffer = await readFile(path)
    if (buffer.subarray(0, SNIFF_BYTES).includes(0)) return null
    return buffer.toString('utf8')
  } catch {
    return null
  }
}

/**
 * Casamentos dentro dos arquivos, agrupados por arquivo.
 *
 * Agrupado e não uma lista plana porque é assim que se lê um resultado de
 * busca: primeiro em QUAIS arquivos está, depois onde dentro deles.
 */
export async function searchFileContents(
  root: string,
  options: FileSearchOptions
): Promise<FileSearchContentResult | { error: 'bad-regex' }> {
  const matcher = buildMatcher(options)
  if (!matcher) return { error: 'bad-regex' }

  const files: FileSearchContentResult['files'] = []
  const budget: Budget = { deadline: Date.now() + TIME_BUDGET_MS, dirs: 0, files: 0 }
  let total = 0
  let skipped = 0
  let stop: SearchStop = null

  const walked = await walk(root, budget, async (entry) => {
    if (entry.isDirectory || entry.isSymlink) return true

    const text = await readSearchable(entry.path)
    if (text === null) {
      skipped++
      return true
    }

    const room = Math.min(MAX_HITS_PER_FILE, MAX_TOTAL_HITS - total)
    const hits: FileSearchHit[] = []
    let more = 0
    const lines = text.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const found = hitsInLine(matcher, i + 1, lines[i].replace(/\r$/, ''), MAX_HITS_PER_FILE)
      if (found.length === 0) continue
      for (const hit of found) {
        if (hits.length < room) hits.push(hit)
        else more++
      }
    }

    if (hits.length === 0 && more === 0) return true
    files.push({ path: entry.path, name: entry.name, hits, more })
    total += hits.length

    if (total >= MAX_TOTAL_HITS || files.length >= MAX_FILES_WITH_HITS) {
      stop = 'results'
      return false
    }
    return true
  })

  return { files, total, skipped, stopped: stop ?? walked }
}
