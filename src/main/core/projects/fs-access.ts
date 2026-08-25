/**
 * Portaria de todo acesso a arquivos vindo do renderer.
 *
 * O renderer roda com contextIsolation e sem `fs`, e a árvore de arquivos é a
 * primeira feature que lhe dá qualquer leitura de disco. Sem allowlist, o canal
 * `fs:list-dir` seria "liste-me qualquer diretório da máquina" para qualquer
 * código que executasse no renderer — que hospeda `<webview>` com páginas
 * arbitrárias nos nós Portal.
 *
 * Duas regras não são opcionais:
 *
 *   1. realpath dos DOIS lados antes de comparar. Um symlink dentro de um
 *      projeto permitido aponta para fora dele, e a comparação textual passa.
 *   2. o separador no prefixo. startsWith('/home/u/proj') casa com
 *      '/home/u/projeto-do-cliente', que é outro diretório.
 */
import { realpath } from 'node:fs/promises'
import { isAbsolute, sep } from 'node:path'

export type FsDenialReason = 'denied' | 'missing' | 'error'

/**
 * As raízes são recalculadas a cada chamada em vez de cacheadas: elas mudam
 * quando o usuário adiciona um projeto ao canvas ou troca de workspace, e um
 * cache furado aqui erra para o lado errado (liberar demais).
 */
export interface AllowedRoots {
  roots: string[]
}

async function realpathSafe(path: string): Promise<string | null> {
  try {
    return await realpath(path)
  } catch {
    return null
  }
}

function isWithin(target: string, root: string): boolean {
  return target === root || target.startsWith(root + sep)
}

/**
 * Devolve o caminho real quando o acesso é permitido, ou o motivo da recusa.
 * Quem chama nunca deve repassar o erro do sistema ao renderer: mensagens de
 * erro de fs vazam a existência e o nome de caminhos fora do escopo.
 */
export async function resolveAllowedPath(
  path: string,
  allowed: AllowedRoots
): Promise<{ ok: true; path: string } | { ok: false; reason: FsDenialReason }> {
  if (!path || !isAbsolute(path)) return { ok: false, reason: 'denied' }

  const target = await realpathSafe(path)
  if (!target) return { ok: false, reason: 'missing' }

  for (const root of allowed.roots) {
    if (!root) continue
    const realRoot = await realpathSafe(root)
    if (realRoot && isWithin(target, realRoot)) return { ok: true, path: target }
  }
  return { ok: false, reason: 'denied' }
}

/** Versão booleana, para testes e verificações rápidas. */
export async function isPathAllowed(path: string, allowed: AllowedRoots): Promise<boolean> {
  const result = await resolveAllowedPath(path, allowed)
  return result.ok
}
