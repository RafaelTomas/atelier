/**
 * Varredura de disco em busca de projetos.
 *
 * EXCEÇÃO DE ARQUITETURA: este módulo lê o sistema de arquivos direto, fora do
 * PersistenceManager. É a mesma exceção do appendScrollback, e pelo mesmo tipo
 * de motivo: o manager existe para dar escrita atômica e codec ao estado do
 * app, e aqui não há estado nem escrita — só leitura em volume. Só a
 * PERSISTÊNCIA do índice passa pelo manager (persistence.saveProjectIndex).
 *
 * Roda no processo main, sem worker_thread. O custo é syscall-bound, não
 * CPU-bound: um worker não reduziria syscalls, só as moveria de thread, e
 * custaria uma entry extra no electron.vite.config.ts que quebraria o bundle
 * esbuild do smoke headless. Com a poda de exclusions.ts o trabalho total cabe
 * em alguns milissegundos, então o main nem sente. Se um dia sentir, a
 * assinatura abaixo isola o motor e a troca é interna.
 *
 * NADA de *Sync aqui. Um readdirSync recursivo trava o main por ~1s com cache
 * quente e 10s+ frio; nesse intervalo o xterm não recebe input, os PTYs
 * bufferizam e o InterAgentServer não faz accept — um `atelier ask` em curso
 * pode estourar o askResponseTimeoutMs.
 */
import { readdir, stat } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import type { DiscoveredProject } from '@shared/types'
import { log } from '../logger'
import { inferKind, isRepository, readProjectMeta } from './detect'
import { DEFAULT_EXCLUDED_DIRS, shouldSkipDir } from './exclusions'

export interface ScanProgress {
  scannedDirs: number
  found: number
  currentPath: string
  elapsedMs: number
}

export interface ScanOptions {
  roots: string[]
  maxDepth: number
  maxDurationMs: number
  maxDirs: number
  excludedDirs?: ReadonlySet<string>
  /** Caminhos absolutos a ignorar (o próprio dataDir do app, por exemplo). */
  excludedPaths?: string[]
  /**
   * Descer nas raízes mesmo que elas próprias qualifiquem como projeto.
   * Ligado no scan geral: uma home com um package.json solto (comum) faria a
   * varredura inteira parar no primeiro diretório. Desligado no scan de pasta
   * escolhida, onde apontar direto para um projeto deve encontrá-lo.
   */
  descendRoots?: boolean
  signal?: { cancelled: boolean }
  onProgress?: (p: ScanProgress) => void
}

export type ScanStop = 'done' | 'cancelled' | 'timeout' | 'limit'

export interface ScanResult {
  projects: DiscoveredProject[]
  scannedDirs: number
  skipped: number
  elapsedMs: number
  stopped: ScanStop
}

/** Leituras de diretório simultâneas. */
const CONCURRENCY = 8

/**
 * 8, e não 64. fs.promises usa o threadpool do libuv (4 threads por padrão),
 * o mesmo que serve o appendScrollback (append de alta frequência, um por
 * chunk de PTY) e o autosave. Enfileirar dezenas de readdir na frente deles
 * atrasa escrita de terminal, e o ganho de vazão acima de 8 é marginal.
 */
const YIELD_EVERY = 200
const PROGRESS_INTERVAL_MS = 150

interface QueueItem {
  path: string
  depth: number
}

export async function scanForProjects(opts: ScanOptions): Promise<ScanResult> {
  const started = Date.now()
  const excludedDirs = opts.excludedDirs ?? DEFAULT_EXCLUDED_DIRS
  const excludedPaths = (opts.excludedPaths ?? []).map((p) => resolve(p))
  const deadline = started + opts.maxDurationMs

  const projects: DiscoveredProject[] = []
  const seen = new Set<string>()
  let scannedDirs = 0
  let skipped = 0
  let stopped: ScanStop = 'done'
  let lastProgress = 0

  // Não cruzar filesystem: uma pasta de NFS, gvfs ou serviço de sync na home é
  // o cenário que transforma uma varredura de 1s numa de minutos. Equivale ao
  // -xdev do find.
  const rootDevices = new Set<number>()
  const queue: QueueItem[] = []

  for (const root of opts.roots) {
    const path = resolve(root)
    try {
      const info = await stat(path)
      if (!info.isDirectory()) continue
      rootDevices.add(info.dev)
      queue.push({ path, depth: 0 })
    } catch {
      skipped++
    }
  }

  const emitProgress = (currentPath: string): void => {
    if (!opts.onProgress) return
    const now = Date.now()
    if (now - lastProgress < PROGRESS_INTERVAL_MS) return
    lastProgress = now
    opts.onProgress({
      scannedDirs,
      found: projects.length,
      currentPath,
      elapsedMs: now - started
    })
  }

  // BFS: a profundidade sai de graça e os projetos rasos — quase sempre os que
  // o usuário quer — aparecem primeiro, então o painel enche com o que importa.
  while (queue.length > 0) {
    if (opts.signal?.cancelled) {
      stopped = 'cancelled'
      break
    }
    if (Date.now() > deadline) {
      stopped = 'timeout'
      break
    }
    if (scannedDirs >= opts.maxDirs) {
      stopped = 'limit'
      break
    }

    const batch = queue.splice(0, CONCURRENCY)
    const results = await Promise.all(batch.map((item) => visit(item)))

    for (const result of results) {
      if (!result) {
        skipped++
        continue
      }
      if (result.project) {
        // Um caminho só entra uma vez, mesmo que apareça sob duas raízes.
        if (!seen.has(result.project.path)) {
          seen.add(result.project.path)
          projects.push(result.project)
        }
        continue
      }
      queue.push(...result.children)
    }

    if (scannedDirs % YIELD_EVERY < CONCURRENCY) {
      await new Promise((r) => setImmediate(r))
    }
    emitProgress(batch[batch.length - 1]?.path ?? '')
  }

  const elapsedMs = Date.now() - started
  log.info(
    'scan',
    `${projects.length} projeto(s) em ${scannedDirs} diretório(s), ${elapsedMs}ms (${stopped})`
  )

  return { projects, scannedDirs, skipped, elapsedMs, stopped }

  /**
   * Visita um diretório. Devolve o projeto encontrado (e então NÃO desce), ou
   * os filhos a visitar. `null` significa diretório ilegível — no macOS o TCC
   * nega Documents/Desktop, e isso não pode derrubar a varredura.
   */
  async function visit(
    item: QueueItem
  ): Promise<{ project: DiscoveredProject | null; children: QueueItem[] } | null> {
    let entries
    try {
      entries = await readdir(item.path, { withFileTypes: true })
    } catch {
      return null
    }
    scannedDirs++

    // Um repositório NÃO é descido. É o que faz um repo com backend/ e
    // frontend/ dentro virar UMA entrada — a dele — e o que impede que cada
    // dependência vendorizada com .git vire projeto. O custo é não enxergar
    // submódulos como entradas próprias: limitação conhecida e documentada.
    const isProject = item.depth === 0 && opts.descendRoots ? false : isRepository(entries)
    if (isProject) {
      try {
        const meta = await readProjectMeta(item.path, entries)
        return { project: { ...meta, ...inferKind(entries) }, children: [] }
      } catch {
        return null
      }
    }

    if (item.depth >= opts.maxDepth) return { project: null, children: [] }

    const children: QueueItem[] = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      // Symlink de diretório: ciclos e árvores duplicadas vêm todos daqui.
      if (entry.isSymbolicLink()) continue
      if (shouldSkipDir(entry.name, excludedDirs)) continue

      const child = join(item.path, entry.name)
      if (excludedPaths.some((p) => child === p || child.startsWith(p + sep))) continue
      children.push({ path: child, depth: item.depth + 1 })
    }

    if (rootDevices.size > 0) {
      const filtered: QueueItem[] = []
      for (const child of children) {
        try {
          const info = await stat(child.path)
          if (rootDevices.has(info.dev)) filtered.push(child)
          else skipped++
        } catch {
          skipped++
        }
      }
      return { project: null, children: filtered }
    }

    return { project: null, children }
  }
}
