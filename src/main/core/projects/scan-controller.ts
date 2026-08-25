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
import type { UUID } from '@shared/types'
import { uuid } from '../coding'
import { log } from '../logger'
import { notifyRenderer } from '../../ipc/notify'
import { dataDir } from '../persistence/paths'
import { projectIndex } from '../state/project-store'
import { scanForProjects, type ScanStop } from './scanner'

export type ScanMode = 'folder' | 'home'

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

    const roots = input.mode === 'home' ? [homedir()] : [input.path ?? '']
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
        maxDepth: input.maxDepth ?? DEFAULT_DEPTH[input.mode],
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

