/**
 * Uma foto do canvas, para o agente ver o que o usuário está vendo.
 *
 * Existe porque `atelier node map` responde "o que existe e onde", e há
 * perguntas que a geometria não responde: se a moldura ficou torta, se um nó
 * está tapando o cabeçalho de outro, se o painel de Git está mostrando o diff
 * ou uma tela de erro. O agente lê o PNG com a ferramenta dele.
 *
 * Devolve o CAMINHO, nunca base64 — mesma razão do `portal shot`: um blob de
 * dois megabytes atravessando o socket do CLI entope o terminal.
 *
 * **A captura é da JANELA INTEIRA**, e é por isso que ela é permissionada por
 * nó (`canvasShotEnabled`, ligado pelo usuário no diálogo do terminal). Ela
 * leva o que estiver na tela: a nota do vizinho, o arquivo aberto num editor, o
 * cofre destrancado. Quem só precisa não empilhar nó usa o `map`.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { UUID } from '@shared/types'
import { log } from './logger'
import { paths } from './persistence/paths'

/**
 * Captura a janela principal em PNG e devolve o caminho.
 *
 * O import do electron é DINÂMICO, como em ipc/notify.ts: fora do app (teste
 * headless, CI) o núcleo continua importável, e a captura falha dizendo o que
 * houve em vez de derrubar a importação inteira.
 */
export async function canvasShot(workspaceId: UUID, destination?: string): Promise<string> {
  const { BrowserWindow } = await import('electron')
  const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
  if (!win) throw new Error('nenhuma janela aberta para fotografar')

  const image = await win.webContents.capturePage()
  if (image.isEmpty()) {
    throw new Error('a captura voltou vazia — a janela pode estar minimizada')
  }

  let file = destination
  if (!file) {
    const dir = paths.shotsDir(workspaceId)
    await mkdir(dir, { recursive: true })
    file = join(dir, `canvas-${Date.now()}.png`)
  }

  await writeFile(file, image.toPNG())
  log.info('canvas', `captura do canvas em ${file}`)
  return file
}
