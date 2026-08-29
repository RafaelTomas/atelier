/**
 * As raízes que o resto do app pode ler em disco.
 *
 * Morava dentro do registro de handlers do ipc/bridge.ts, quando o único
 * consumidor era o renderer. O `atelier editor open` fez surgir o segundo: ele
 * roda no main, vindo do socket do CLI, e precisa da MESMA allowlist — duas
 * cópias da regra divergiriam na primeira raiz nova, e divergir aqui erra para
 * o lado de liberar demais.
 *
 * Fica em core/projects, e não em ipc/, porque não depende de `electron`: é o
 * que mantém o smoke headless capaz de exercitar a recusa.
 *
 * Recalculado a cada chamada de propósito — as raízes mudam quando o usuário
 * adiciona um projeto ao canvas ou troca de workspace. Ver fs-access.ts.
 */
import { appState } from '../state/app-state'
import { projectIndex } from '../state/project-store'
import type { AllowedRoots } from './fs-access'

export function allowedRoots(): AllowedRoots {
  const roots = projectIndex.all.map((p) => p.path)
  const ws = appState.activeWorkspace
  if (ws) {
    if (ws.payload.workingDirectory) roots.push(ws.payload.workingDirectory)
    for (const node of ws.nodes) {
      if (node.content.type === 'fileTree' && node.content.value.rootPath) {
        roots.push(node.content.value.rootPath)
      }
    }
  }
  return { roots }
}
