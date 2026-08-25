/**
 * Listagem de um diretório para a árvore do nó de projeto.
 *
 * Um nível por chamada, sob demanda. Recursão aqui seria o mesmo erro do
 * scanner sem poda: abrir um `node_modules` por engano mandaria dezenas de
 * milhares de objetos pelo IPC estruturado, que os clona um a um.
 */
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { FsEntry } from '@shared/types'

/** Acima disto a lista deixa de ser navegável e vira só custo de serialização. */
const MAX_ENTRIES = 1000

export interface ListDirResult {
  entries: FsEntry[]
  truncated: number
  /** Quantas entradas o .gitignore escondeu — a UI oferece revelá-las. */
  ignored: number
}

/**
 * Nomes ignorados pelo .gitignore da raiz do projeto.
 *
 * Deliberadamente ingênuo: só linhas que são um nome simples, sem glob, sem
 * caminho e sem negação. Implementar a semântica real do gitignore (âncoras,
 * precedência, `**`, negações) é um projeto próprio, e o que resolve 95% do
 * ruído visual são as poucas linhas triviais: node_modules, dist, .env.
 * Quem quiser ver o resto tem o botão de revelar.
 */
export async function readIgnoreNames(root: string): Promise<Set<string>> {
  const names = new Set<string>(['.git'])
  let text: string
  try {
    text = await readFile(join(root, '.gitignore'), 'utf8')
  } catch {
    return names
  }
  for (const raw of text.split('\n')) {
    const line = raw.trim().replace(/\/$/, '')
    if (!line || line.startsWith('#') || line.startsWith('!')) continue
    if (/[*?\[\]]/.test(line) || line.includes('/')) continue
    names.add(line)
  }
  return names
}

export async function listDirectory(path: string, ignore?: ReadonlySet<string>): Promise<ListDirResult> {
  const raw = await readdir(path, { withFileTypes: true })

  const usable = raw.filter((e) => e.isDirectory() || e.isFile() || e.isSymbolicLink())
  const kept = ignore ? usable.filter((e) => !ignore.has(e.name)) : usable

  const entries: FsEntry[] = kept
    .map((e) => ({
      name: e.name,
      path: join(path, e.name),
      isDirectory: e.isDirectory(),
      isSymlink: e.isSymbolicLink()
    }))
    // Pastas antes de arquivos, cada grupo em ordem natural — a mesma ordem que
    // qualquer explorador de arquivos usa, e que o olho já espera.
    .sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
      return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
    })

  return {
    entries: entries.slice(0, MAX_ENTRIES),
    truncated: Math.max(0, entries.length - MAX_ENTRIES),
    ignored: usable.length - kept.length
  }
}
