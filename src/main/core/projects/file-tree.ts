/**
 * Listagem de um diretório para a árvore do nó de projeto.
 *
 * Um nível por chamada, sob demanda. Recursão aqui seria o mesmo erro do
 * scanner sem poda: abrir um `node_modules` por engano mandaria dezenas de
 * milhares de objetos pelo IPC estruturado, que os clona um a um.
 */
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { FsEntry } from '@shared/types'

/** Acima disto a lista deixa de ser navegável e vira só custo de serialização. */
const MAX_ENTRIES = 1000

export interface ListDirResult {
  entries: FsEntry[]
  truncated: number
}

/**
 * Lista um nível: TUDO que está na pasta, sem filtro.
 *
 * Houve um filtro por .gitignore aqui, e ele fazia mais mal do que bem — pasta
 * de trabalho de verdade (`docs/`, `.env`) sumia da árvore sem aviso, e a regra
 * ingênua de casar nomes errava nas duas direções. Uma árvore de arquivos que
 * esconde arquivos não é uma árvore de arquivos.
 *
 * `.git` é a ÚNICA exceção: ninguém navega nele pela árvore, e são milhares de
 * objetos internos. Se algum dia alguém precisar, é aqui que a exceção mora.
 */
export async function listDirectory(path: string): Promise<ListDirResult> {
  const raw = await readdir(path, { withFileTypes: true })

  const usable = raw
    .filter((e) => e.isDirectory() || e.isFile() || e.isSymbolicLink())
    .filter((e) => e.name !== '.git')

  const entries: FsEntry[] = usable
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
    truncated: Math.max(0, entries.length - MAX_ENTRIES)
  }
}
