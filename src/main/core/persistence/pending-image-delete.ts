/**
 * Os bytes de uma imagem apagada ficam de molho enquanto o undo puder voltar.
 *
 * `node:remove` sempre apagou o arquivo da imagem na hora — e isso era certo
 * enquanto remover era definitivo. Com o desfazer, apagar na hora significa um
 * nó que volta vazio: o retângulo certo, no lugar certo, sem imagem nenhuma. O
 * arquivo é o único pedaço do nó que o snapshot NÃO carrega (podem ser
 * megabytes; o snapshot vive na memória do renderer e atravessa o IPC).
 *
 * Então o delete espera a janela de undo. Quem restaura cancela; quem deixa
 * passar perde. O timer mora aqui, no main, e não no renderer, por dois
 * motivos: o renderer pode ser recarregado no meio da janela (em dev isso
 * acontece a cada save) e ninguém apagaria o arquivo depois; e o shutdown
 * precisa de um lugar para drenar o que ficou pendente, senão sair do app no
 * minuto errado deixaria o arquivo órfão para sempre.
 *
 * Módulo sem `electron`: só um Map e timers.
 */
import type { UUID } from '@shared/types'
import { UNDO_WINDOW_MS } from '@shared/node-undo'
import { log } from '../logger'

type DeleteImage = (workspaceId: UUID, fileName: string) => Promise<void>

interface Pending {
  workspaceId: UUID
  fileName: string
  remove: DeleteImage
  timer: ReturnType<typeof setTimeout>
}

/** Por nodeId: um nó de imagem tem no máximo um arquivo pendente. */
const pending = new Map<UUID, Pending>()

/**
 * Marca o arquivo para morrer quando a janela de undo fechar.
 *
 * Se o mesmo nó já tinha um pendente (apagar → desfazer → apagar de novo), o
 * anterior é substituído: vale o último gesto, com a janela contada dele.
 */
export function scheduleImageDelete(
  nodeId: UUID,
  workspaceId: UUID,
  fileName: string,
  remove: DeleteImage
): void {
  cancelImageDelete(nodeId)
  const timer = setTimeout(() => {
    pending.delete(nodeId)
    void remove(workspaceId, fileName).catch(() => undefined)
  }, UNDO_WINDOW_MS)
  // Um timer pendente não pode segurar o processo vivo no encerramento.
  timer.unref?.()
  pending.set(nodeId, { workspaceId, fileName, remove, timer })
}

/** O nó voltou: os bytes ficam. */
export function cancelImageDelete(nodeId: UUID): void {
  const entry = pending.get(nodeId)
  if (!entry) return
  clearTimeout(entry.timer)
  pending.delete(nodeId)
}

/**
 * Executa AGORA tudo o que estava esperando. É o que o `before-quit` chama: o
 * app fechando é o fim da janela de undo, e o que já estava condenado não pode
 * sobreviver como arquivo sem dono.
 */
export async function flushImageDeletes(): Promise<void> {
  const entries = [...pending.values()]
  pending.clear()
  for (const entry of entries) clearTimeout(entry.timer)
  if (entries.length === 0) return
  log.info('persistence', `apagando ${entries.length} imagem(ns) que esperavam o undo`)
  await Promise.all(
    entries.map((e) => e.remove(e.workspaceId, e.fileName).catch(() => undefined))
  )
}
