/**
 * Adicionar um projeto à mão.
 *
 * O scan é a ferramenta do primeiro dia; no uso corrente o gesto é apontar UMA
 * pasta. E aqui `.git` NÃO é exigido de propósito: a regra do repositório existe
 * para a descoberta automática não errar, varrendo uma home inteira sem
 * supervisão. Uma pasta escolhida a dedo é decisão explícita de quem sabe o que
 * quer — recusá-la seria o app discutindo com o usuário. É a única porta de
 * entrada para projeto sem versionamento.
 */
import { readdir, realpath, stat } from 'node:fs/promises'
import type { Project } from '@shared/types'
import { log } from '../logger'
import { projectIndex } from '../state/project-store'
import { inferKind, readProjectMeta } from './detect'

export async function addProjectFolder(path: string): Promise<{ project: Project } | { error: string }> {
  if (!path) return { error: 'nenhuma pasta escolhida' }

  // realpath dos dois lados: sem isto o mesmo projeto entra duas vezes quando
  // um dos caminhos passa por symlink — é a mesma regra do fs-access.
  let real: string
  try {
    real = await realpath(path)
    if (!(await stat(real)).isDirectory()) return { error: 'isso não é uma pasta' }
  } catch {
    return { error: 'a pasta não existe ou não pode ser lida' }
  }

  let entries
  try {
    entries = await readdir(real, { withFileTypes: true })
  } catch {
    return { error: 'sem permissão para ler a pasta' }
  }

  const meta = await readProjectMeta(real, entries)
  const project = await projectIndex.add({ ...meta, ...inferKind(entries) })
  log.info('projects', `projeto adicionado à mão: ${project.name}`)
  return { project }
}
