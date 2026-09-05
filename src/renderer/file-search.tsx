/**
 * A busca da árvore de arquivos: a barra, os resultados e o filtro.
 *
 * Dois modos, os mesmos dois do VS Code, porque é o vocabulário que quem usa
 * este app já tem no dedo:
 *
 *   • **nome** — filtra a PRÓPRIA árvore. Os casamentos e os ancestrais deles
 *     ficam; o resto sai da vista. É a árvore de sempre, com as mesmas linhas,
 *     o mesmo menu de contexto, o mesmo arrastar e os mesmos pontos do git —
 *     por isso o filtro é um conjunto de caminhos visíveis entregue ao
 *     `renderLevel`, e não uma segunda árvore desenhada aqui. Uma segunda
 *     árvore teria de reimplementar tudo aquilo, e ficaria para trás na
 *     primeira mudança feita na primeira.
 *
 *   • **conteúdo** — substitui a árvore por uma lista de casamentos agrupada
 *     por arquivo, e clicar num deles abre o arquivo no editor NA LINHA.
 *
 * O estado mora aqui num controlador (`useFileSearch`) em vez de na árvore
 * porque a árvore já tem estado demais, e nada disto sobrevive a fechar a
 * busca: é o que a pessoa está procurando AGORA.
 *
 * A busca varre o disco no processo principal, não filtra o que já está na
 * tela. É a diferença entre achar `state/store.ts` digitando e ter de abrir
 * `src` e `renderer` na mão antes.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  FileSearchContentResult,
  FileSearchNamesResult,
  FileSearchOptions
} from '@shared/types'
import { IconSearch } from './icons'

export type SearchMode = 'name' | 'content'

/** Debounce por modo: ler o disco de um projeto inteiro custa mais que listar nomes. */
const DEBOUNCE_MS: Record<SearchMode, number> = { name: 150, content: 300 }

const ERROR_TEXT: Record<string, string> = {
  'bad-regex': 'expressão regular inválida',
  denied: 'sem permissão para buscar nesta pasta',
  missing: 'esta pasta não existe mais',
  error: 'não foi possível buscar'
}

/**
 * O aviso de busca incompleta. Existe porque uma busca que para no meio e não
 * diz que parou MENTE: quem lê "3 resultados" conclui que há três.
 */
const STOP_TEXT: Record<string, string> = {
  results: 'muitos resultados — mostrando os primeiros',
  files: 'projeto grande — a varredura parou antes do fim',
  time: 'a busca demorou demais e parou no meio'
}

export interface FileSearch {
  open: boolean
  mode: SearchMode
  query: string
  options: FileSearchOptions
  busy: boolean
  error: string | null
  names: FileSearchNamesResult | null
  contents: FileSearchContentResult | null
  /**
   * Caminhos que a árvore deve mostrar no modo nome — casamentos MAIS os
   * ancestrais de cada um, senão o galho não teria por onde ser desenhado.
   * null quando não há filtro ativo, e aí a árvore é a de sempre.
   */
  visible: Set<string> | null
  /**
   * Só as PASTAS de `visible`. A árvore precisa deste corte para não pedir
   * `list-dir` de um arquivo casado: o main responderia `ENOTDIR` para cada
   * resultado, uma ida ao processo principal por arquivo achado, para nada.
   */
  visibleDirs: Set<string> | null
  setOpen: (open: boolean) => void
  setMode: (mode: SearchMode) => void
  setQuery: (query: string) => void
  toggle: (option: 'caseSensitive' | 'wholeWord' | 'regex') => void
  /** Fecha e limpa. É o Escape dentro do campo. */
  reset: () => void
}

export function useFileSearch(root: string): FileSearch {
  const [open, setOpenState] = useState(false)
  const [mode, setModeState] = useState<SearchMode>('name')
  const [query, setQuery] = useState('')
  const [options, setOptions] = useState<Omit<FileSearchOptions, 'query'>>({
    caseSensitive: false,
    wholeWord: false,
    regex: false
  })
  const [names, setNames] = useState<FileSearchNamesResult | null>(null)
  const [contents, setContents] = useState<FileSearchContentResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  /**
   * Sequência da última busca disparada. Digitar rápido dispara várias, e elas
   * voltam fora de ordem — sem esta trava, o resultado de `sto` chegando depois
   * do de `store` sobrescreveria a resposta certa por uma mais antiga.
   */
  const runId = useRef(0)

  const clear = useCallback((): void => {
    runId.current++
    setNames(null)
    setContents(null)
    setError(null)
    setBusy(false)
  }, [])

  const reset = useCallback((): void => {
    setOpenState(false)
    setQuery('')
    clear()
  }, [clear])

  // Trocar a raiz invalida qualquer resultado: eles são caminhos da raiz velha.
  useEffect(() => {
    clear()
  }, [root, clear])

  useEffect(() => {
    const term = query.trim()
    if (!open || !term || !root) {
      clear()
      return
    }

    const id = ++runId.current
    setBusy(true)
    const timer = setTimeout(() => {
      void (async () => {
        const request: FileSearchOptions = { query: term, ...options }
        const result =
          mode === 'name'
            ? await window.atelier.fs.searchNames(root, request)
            : await window.atelier.fs.searchContent(root, request)
        // Resposta de uma busca que já não é a atual: descartada.
        if (id !== runId.current) return
        setBusy(false)
        if ('error' in result) {
          setError(ERROR_TEXT[result.error] ?? ERROR_TEXT.error)
          setNames(null)
          setContents(null)
          return
        }
        setError(null)
        if ('entries' in result) {
          setNames(result)
          setContents(null)
        } else {
          setContents(result)
          setNames(null)
        }
      })()
    }, DEBOUNCE_MS[mode])

    return () => clearTimeout(timer)
  }, [open, root, query, mode, options, clear])

  /**
   * O conjunto visível: cada casamento e todos os diretórios acima dele até a
   * raiz. Calculado uma vez por resultado, não a cada linha desenhada — a
   * árvore consulta este `Set` uma vez por entrada.
   */
  const { visible, visibleDirs } = useMemo((): {
    visible: Set<string> | null
    visibleDirs: Set<string> | null
  } => {
    if (!open || mode !== 'name' || !names) return { visible: null, visibleDirs: null }
    const set = new Set<string>()
    const dirs = new Set<string>()
    for (const entry of names.entries) {
      set.add(entry.path)
      if (entry.isDirectory) dirs.add(entry.path)
      let dir = parentOf(entry.path)
      // `> root.length` e não `!== root`: no Windows o caminho pode chegar com
      // separador diferente do da raiz, e comparar por igualdade subiria até o
      // topo do disco.
      while (dir.length > root.length) {
        if (set.has(dir) && dirs.has(dir)) break // este ramo já foi subido
        set.add(dir)
        dirs.add(dir)
        dir = parentOf(dir)
      }
    }
    return { visible: set, visibleDirs: dirs }
  }, [open, mode, names, root])

  const setOpen = useCallback(
    (next: boolean): void => {
      setOpenState(next)
      if (!next) {
        setQuery('')
        clear()
      }
    },
    [clear]
  )

  const setMode = useCallback(
    (next: SearchMode): void => {
      setModeState(next)
      // Resultado do modo anterior não serve para o novo, e deixá-lo na tela
      // durante o debounce mostraria a resposta de outra pergunta.
      clear()
    },
    [clear]
  )

  const toggle = useCallback((option: 'caseSensitive' | 'wholeWord' | 'regex'): void => {
    setOptions((prev) => ({ ...prev, [option]: !prev[option] }))
  }, [])

  return {
    open,
    mode,
    query,
    options: { query, ...options },
    busy,
    error,
    names,
    contents,
    visible,
    visibleDirs,
    setOpen,
    setMode,
    setQuery,
    toggle,
    reset
  }
}

// ─── A barra ──────────────────────────────────────────────────────────────────

interface BarProps {
  search: FileSearch
}

/**
 * O campo, o seletor de modo e os três interruptores.
 *
 * Os rótulos são os do VS Code (`Aa`, `ab|`, `.*`) de propósito: são símbolos
 * que quem procura texto já reconhece, e traduzi-los para palavras ocuparia a
 * barra inteira sem ensinar nada a ninguém.
 */
export function FileSearchBar({ search }: BarProps): JSX.Element {
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    input.current?.focus()
    input.current?.select()
  }, [])

  return (
    <div className="file-search" data-node-interactive>
      <div className="file-search-modes" role="tablist" aria-label="Modo de busca">
        <button
          type="button"
          role="tab"
          aria-selected={search.mode === 'name'}
          className={search.mode === 'name' ? 'is-active' : ''}
          title="Buscar por nome de arquivo e pasta"
          onClick={() => search.setMode('name')}
        >
          nome
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={search.mode === 'content'}
          className={search.mode === 'content' ? 'is-active' : ''}
          title="Buscar texto dentro dos arquivos"
          onClick={() => search.setMode('content')}
        >
          conteúdo
        </button>
      </div>

      <div className="file-search-field">
        <span className="file-search-icon">
          <IconSearch size={13} />
        </span>
        <input
          ref={input}
          className="file-search-input"
          value={search.query}
          placeholder={search.mode === 'name' ? 'nome ou caminho…' : 'texto nos arquivos…'}
          spellCheck={false}
          onChange={(e) => search.setQuery(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') search.reset()
            // O canvas escuta teclas na janela: sem isto, digitar na busca de um
            // nó dispararia os atalhos de ferramenta por baixo.
            e.stopPropagation()
          }}
        />
        {search.query && (
          <button
            type="button"
            className="file-search-clear"
            title="Limpar"
            onClick={() => search.setQuery('')}
          >
            ✕
          </button>
        )}
        <div className="file-search-flags">
          <button
            type="button"
            className={search.options.caseSensitive ? 'is-active' : ''}
            title="Diferenciar maiúsculas de minúsculas"
            onClick={() => search.toggle('caseSensitive')}
          >
            Aa
          </button>
          <button
            type="button"
            className={search.options.wholeWord ? 'is-active' : ''}
            title="Palavra inteira"
            onClick={() => search.toggle('wholeWord')}
          >
            ab|
          </button>
          <button
            type="button"
            className={search.options.regex ? 'is-active' : ''}
            title="Expressão regular"
            onClick={() => search.toggle('regex')}
          >
            .*
          </button>
        </div>
      </div>

      <FileSearchSummary search={search} />
    </div>
  )
}

/** Uma linha só dizendo o que a busca achou — e o que ela NÃO chegou a ver. */
function FileSearchSummary({ search }: BarProps): JSX.Element | null {
  if (search.error) return <div className="file-search-note is-error">{search.error}</div>
  if (!search.query.trim()) return null
  if (search.busy) return <div className="file-search-note">buscando…</div>

  const stopped = search.names?.stopped ?? search.contents?.stopped ?? null
  const aviso = stopped ? <span className="file-search-stop">{STOP_TEXT[stopped]}</span> : null

  if (search.mode === 'name') {
    const total = search.names?.entries.length ?? 0
    return (
      <div className="file-search-note">
        {total === 0 ? 'nenhum nome casa' : `${total} ${total === 1 ? 'item' : 'itens'}`}
        {aviso}
      </div>
    )
  }

  const files = search.contents?.files.length ?? 0
  const total = search.contents?.total ?? 0
  return (
    <div className="file-search-note">
      {total === 0
        ? 'nenhuma ocorrência'
        : `${total} ${total === 1 ? 'ocorrência' : 'ocorrências'} em ${files} ${
            files === 1 ? 'arquivo' : 'arquivos'
          }`}
      {aviso}
    </div>
  )
}

// ─── Os resultados da busca em conteúdo ───────────────────────────────────────

interface ResultsProps {
  search: FileSearch
  root: string
  /** Abre o arquivo no editor, na linha do casamento. */
  onOpen: (path: string, line: number) => void
}

export function FileSearchResults({ search, root, onOpen }: ResultsProps): JSX.Element {
  /**
   * Arquivos RECOLHIDOS, não expandidos: um resultado de busca nasce aberto —
   * o que se quer ver é onde está, não uma lista de nomes para clicar de novo.
   */
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const result = search.contents

  // Cada busca nova é outra lista: manter o recolhido da anterior esconderia
  // arquivos que a pessoa nunca recolheu.
  useEffect(() => setCollapsed(new Set()), [result])

  if (!search.query.trim()) {
    return <div className="file-search-empty">Digite para buscar dentro dos arquivos.</div>
  }
  if (!result || search.error) return <div className="file-search-body" />
  if (result.files.length === 0 && !search.busy) {
    return <div className="file-search-empty">Nenhuma ocorrência.</div>
  }

  const toggle = (path: string): void =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (!next.delete(path)) next.add(path)
      return next
    })

  return (
    <div className="file-search-body">
      {result.files.map((file) => {
        const isOpen = !collapsed.has(file.path)
        const relative = file.path.slice(root.length + 1) || file.name
        // Arquivo na raiz não tem pasta a mostrar. Sem este corte o rótulo
        // repetiria o nome do arquivo, porque `parentOf` de um caminho sem
        // separador devolve o próprio caminho.
        const dirLabel = /[\\/]/.test(relative) ? parentOf(relative) : ''
        return (
          <div key={file.path} className="file-search-group">
            <button
              type="button"
              className="file-search-file"
              title={file.path}
              onClick={() => toggle(file.path)}
            >
              <span className="file-tree-caret">{isOpen ? '▾' : '▸'}</span>
              <span className="file-tree-icon">📄</span>
              <span className="file-search-file-name">{file.name}</span>
              {dirLabel && <span className="file-search-file-dir">{dirLabel}</span>}
              <span className="file-search-count">{file.hits.length + file.more}</span>
            </button>
            {isOpen &&
              file.hits.map((hit, i) => (
                <button
                  type="button"
                  key={`${hit.line}:${hit.column}:${i}`}
                  className="file-search-hit"
                  title={`${relative}:${hit.line}`}
                  onClick={() => onOpen(file.path, hit.line)}
                >
                  <span className="file-search-line">{hit.line}</span>
                  <span className="file-search-text">
                    <Highlight text={hit.text} column={hit.column} length={hit.length} />
                  </span>
                </button>
              ))}
            {isOpen && file.more > 0 && (
              <div className="file-search-more">… mais {file.more} neste arquivo</div>
            )}
          </div>
        )
      })}
    </div>
  )
}

/**
 * Realça o trecho que casou.
 *
 * `column` e `length` vêm do main, medidos no MESMO texto que chega aqui — a
 * linha já cortada. Recalcular o casamento no renderer exigiria repetir a
 * montagem do regex (escape, palavra inteira, maiúsculas) num segundo lugar, e
 * os dois divergiriam na primeira mudança de um deles.
 */
function Highlight({
  text,
  column,
  length
}: {
  text: string
  column: number
  length: number
}): JSX.Element {
  if (length <= 0 || column < 0 || column > text.length) return <>{text}</>
  return (
    <>
      {text.slice(0, column)}
      <mark>{text.slice(column, column + length)}</mark>
      {text.slice(column + length)}
    </>
  )
}

/**
 * Realce do nome no modo nome.
 *
 * Aqui o casamento NÃO vem do main — a busca por nome devolve entradas, não
 * posições. Com expressão regular ligada o realce é omitido em vez de adivinhado:
 * um `indexOf` do texto da expressão marcaria o lugar errado, e marcar errado é
 * pior do que não marcar.
 */
export function highlightName(
  name: string,
  search: FileSearch
): { before: string; match: string; after: string } | null {
  const term = search.query.trim()
  if (!term || search.options.regex) return null
  const haystack = search.options.caseSensitive ? name : name.toLowerCase()
  const needle = search.options.caseSensitive ? term : term.toLowerCase()
  const at = haystack.indexOf(needle)
  if (at < 0) return null
  return {
    before: name.slice(0, at),
    match: name.slice(at, at + needle.length),
    after: name.slice(at + needle.length)
  }
}

/** Aceita os dois separadores: o main devolve `\\` no Windows. */
function parentOf(path: string): string {
  return path.replace(/[\\/][^\\/]*$/, '')
}
