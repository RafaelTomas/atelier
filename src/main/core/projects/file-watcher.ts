/**
 * Vigia os arquivos ABERTOS no editor — e só eles.
 *
 * O caso é comum aqui: o agente num nó do canvas edita o arquivo que está
 * aberto no editor ao lado. Sem isto, o editor mostraria uma versão morta e o
 * primeiro save do usuário desfaria o trabalho do agente.
 *
 * Watch RECURSIVO está fora de questão: no Linux o inotify tem um teto de
 * instâncias por usuário, e assinar uma árvore de projeto inteira o estoura —
 * é a mesma razão pela qual a árvore de arquivos lista um nível por vez. Aqui
 * cada assinatura é um caminho exato, com contagem de referências: dois nós no
 * mesmo arquivo compartilham um watcher, e ele morre quando o último solta.
 */
import { EventEmitter } from 'node:events'
import chokidar, { type FSWatcher } from 'chokidar'
import { log } from '../logger'

interface Entry {
  watcher: FSWatcher
  refs: number
}

class FileWatcher extends EventEmitter {
  private entries = new Map<string, Entry>()

  /** O caminho JÁ resolvido pela allowlist — quem chama é o bridge. */
  watch(path: string): void {
    const existing = this.entries.get(path)
    if (existing) {
      existing.refs++
      return
    }

    const watcher = chokidar.watch(path, {
      // `depth: 0` e um caminho de arquivo: nada de árvore, nada de recursão.
      depth: 0,
      ignoreInitial: true,
      // O editor de texto médio grava por rename do temporário (é o que o
      // atelier faz também): sem espera, o evento chega no meio da troca.
      awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 }
    })

    watcher.on('change', () => this.emit('changed', path))
    watcher.on('unlink', () => this.emit('removed', path))
    watcher.on('error', (err) => log.error('watch', `falha vigiando ${path}`, err))

    this.entries.set(path, { watcher, refs: 1 })
  }

  unwatch(path: string): void {
    const entry = this.entries.get(path)
    if (!entry) return
    entry.refs--
    if (entry.refs > 0) return
    this.entries.delete(path)
    void entry.watcher.close()
  }

  /** Fecha tudo — usado no shutdown. */
  async closeAll(): Promise<void> {
    for (const [, entry] of this.entries) await entry.watcher.close()
    this.entries.clear()
  }
}

export const fileWatcher = new FileWatcher()
