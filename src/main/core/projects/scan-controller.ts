/**
 * Orquestra a varredura: um scan por vez, com progresso e cancelamento.
 *
 * O estado de um scan é curto e efêmero demais para virar arquivo — vive aqui,
 * do jeito que o ConnectionManager guarda o status das conexões. Quem persiste
 * é o ProjectStore, no fim.
 *
 * A regra de "no máximo um" existe porque dois scans concorrentes sobre as
 * mesmas raízes disputariam o threadpool do libuv e fariam merges que se
 * sobrescrevem, com resultado dependente de quem terminasse por último.
 */
import { homedir } from 'node:os'
import type { DiscoveredProject, UUID } from '@shared/types'
import { uuid } from '../coding'
import { log } from '../logger'
import { notifyRenderer } from '../../ipc/notify'
import { dataDir } from '../persistence/paths'
import { appState } from '../state/app-state'
import { projectIndex } from '../state/project-store'
import { scanForProjects, type ScanStop } from './scanner'

/** As raízes configuradas em Preferências, ou a home quando a lista está vazia. */
function configuredRoots(): string[] {
  const roots = appState.preferences.scanRoots
  return roots.length > 0 ? roots : [homedir()]
}

export type ScanMode = 'folder' | 'home'

/**
 * Projetos achados na varredura do boot que ainda não estão no índice. Ficam
 * aqui até o usuário responder — o main é quem guarda, e não o renderer, para
 * a resposta sobreviver a um F5 e para o renderer poder perguntar quando montar
 * em vez de depender de ter chegado a tempo no evento.
 */
let pendingCandidates: DiscoveredProject[] = []

export interface ActiveScan {
  scanId: UUID
  mode: ScanMode
  roots: string[]
  startedAt: number
}

export interface StartScanInput {
  mode: ScanMode
  path?: string
  maxDepth?: number
}

/** Profundidade padrão: a home é larga e rasa; uma pasta escolhida é o oposto. */
const DEFAULT_DEPTH: Record<ScanMode, number> = { home: 6, folder: 8 }
const MAX_DURATION_MS = 60_000
const MAX_DIRS = 50_000

class ScanController {
  private current: ActiveScan | null = null
  private signal = { cancelled: false }

  get active(): ActiveScan | null {
    return this.current
  }

  async start(input: StartScanInput): Promise<{ scanId: UUID } | { error: string }> {
    if (this.current) return { error: 'já existe uma varredura em andamento' }

    const roots = input.mode === 'home' ? configuredRoots() : [input.path ?? '']
    if (roots.some((r) => !r)) return { error: 'nenhuma pasta escolhida' }

    const scanId = uuid()
    this.signal = { cancelled: false }
    this.current = { scanId, mode: input.mode, roots, startedAt: Date.now() }

    // Não aguardamos: o IPC responde na hora com o scanId e a UI acompanha
    // pelos eventos. Uma varredura de home pode levar segundos, e travar o
    // invoke deixaria o renderer sem meio de cancelar.
    void this.run(scanId, input, roots)
    return { scanId }
  }

  cancel(scanId?: UUID): void {
    if (!this.current) return
    if (scanId && scanId !== this.current.scanId) return
    this.signal.cancelled = true
    log.info('scan', 'cancelamento pedido')
  }

  private async run(scanId: UUID, input: StartScanInput, roots: string[]): Promise<void> {
    let stopped: ScanStop = 'done'
    try {
      const result = await scanForProjects({
        roots,
        // A home quase sempre tem algum manifesto solto na raiz; sem isto a
        // varredura inteira pararia no primeiro diretório.
        descendRoots: input.mode === 'home',
        maxDepth:
          input.maxDepth ?? (input.mode === 'home' ? appState.preferences.scanMaxDepth : DEFAULT_DEPTH.folder),
        maxDurationMs: MAX_DURATION_MS,
        maxDirs: MAX_DIRS,
        // O próprio diretório de dados do app nunca é projeto do usuário.
        excludedPaths: [dataDir()],
        signal: this.signal,
        onProgress: (p) => notifyRenderer('project:scan-progress', { scanId, ...p })
      })
      stopped = result.stopped

      const summary = await projectIndex.mergeScan(result.projects, {
        roots,
        // Só um scan que chegou ao fim provou que algo sumiu do disco.
        archiveMissing: result.stopped === 'done'
      })

      notifyRenderer('project:scan-done', {
        scanId,
        ...summary,
        stopped,
        scannedDirs: result.scannedDirs,
        skipped: result.skipped,
        elapsedMs: result.elapsedMs
      })
    } catch (err) {
      log.error('scan', 'varredura falhou', err)
      notifyRenderer('project:scan-done', {
        scanId,
        added: 0,
        updated: 0,
        archived: 0,
        stopped: 'error',
        error: (err as Error).message
      })
    } finally {
      this.current = null
    }
  }
}

export const scanController = new ScanController()

/**
 * A varredura de cada boot.
 *
 * Diferente do scan pedido à mão em dois pontos que importam: **nada entra no
 * índice sem o usuário dizer que sim** (`addNew: false`) e ela não emite
 * progresso — ninguém pediu, então ela não pode aparecer na tela como trabalho
 * acontecendo. O que já é conhecido é atualizado e o que sumiu é arquivado,
 * porque isso é manutenção do que o usuário já aceitou.
 */
export async function scanOnLaunch(): Promise<DiscoveredProject[]> {
  const known = projectIndex.snapshot
  // Se o usuário já escolheu onde varrer, respeita a escolha; senão, a home.
  const roots = known.scanRoots.length > 0 ? known.scanRoots : [homedir()]

  const result = await scanForProjects({
    roots,
    descendRoots: true,
    maxDepth: DEFAULT_DEPTH.home,
    maxDurationMs: MAX_DURATION_MS,
    maxDirs: MAX_DIRS,
    excludedPaths: [dataDir()]
  })

  await projectIndex.mergeScan(result.projects, {
    roots,
    archiveMissing: result.stopped === 'done',
    addNew: false
  })

  pendingCandidates = result.projects.filter(
    (p) => !projectIndex.byPath(p.path) && !projectIndex.isIgnored(p.path)
  )
  log.info(
    'scan',
    `boot: ${result.projects.length} no disco, ${pendingCandidates.length} novo(s) para oferecer`
  )
  if (pendingCandidates.length > 0) {
    notifyRenderer('project:candidates', { candidates: pendingCandidates })
  }
  return pendingCandidates
}

export function candidates(): DiscoveredProject[] {
  return pendingCandidates
}

/** Tira da fila de oferta — o usuário já respondeu sobre estes. */
export function clearCandidates(paths: string[]): void {
  const gone = new Set(paths)
  pendingCandidates = pendingCandidates.filter((c) => !gone.has(c.path))
}
