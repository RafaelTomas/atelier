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
import { basename, dirname, isAbsolute, join, sep } from 'node:path'

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
): Promise<AllowedPath | { ok: false; reason: FsDenialReason }> {
  if (!path || !isAbsolute(path)) return { ok: false, reason: 'denied' }

  const target = await realpathSafe(path)
  if (!target) return { ok: false, reason: 'missing' }

  return matchRoot(target, allowed)
}

/** O caminho real e a raiz permitida sob a qual ele caiu. */
export interface AllowedPath {
  ok: true
  path: string
  /** Qual raiz autorizou. É o que permite exigir origem e destino na MESMA. */
  root: string
}

async function matchRoot(
  target: string,
  allowed: AllowedRoots
): Promise<AllowedPath | { ok: false; reason: FsDenialReason }> {
  for (const root of allowed.roots) {
    if (!root) continue
    const realRoot = await realpathSafe(root)
    if (realRoot && isWithin(target, realRoot)) return { ok: true, path: target, root: realRoot }
  }
  return { ok: false, reason: 'denied' }
}

/**
 * Resolve um caminho que AINDA NÃO EXISTE — o destino de um renomear, mover ou
 * duplicar.
 *
 * `realpath` de um arquivo inexistente falha, então quem valida é o diretório
 * pai: ele existe, é resolvido de verdade (symlink incluído) e o último
 * componente é colado de volta. Um nome com separador é recusado de saída — é
 * assim que "renomear para `../../.ssh/authorized_keys`" morre aqui.
 */
export async function resolveAllowedTarget(
  path: string,
  allowed: AllowedRoots
): Promise<AllowedPath | { ok: false; reason: FsDenialReason }> {
  if (!path || !isAbsolute(path)) return { ok: false, reason: 'denied' }

  const name = basename(path)
  if (!name || name === '.' || name === '..') return { ok: false, reason: 'denied' }

  const parent = await realpathSafe(dirname(path))
  if (!parent) return { ok: false, reason: 'missing' }

  return matchRoot(join(parent, name), allowed)
}

/** Versão booleana, para testes e verificações rápidas. */
export async function isPathAllowed(path: string, allowed: AllowedRoots): Promise<boolean> {
  const result = await resolveAllowedPath(path, allowed)
  return result.ok
}
