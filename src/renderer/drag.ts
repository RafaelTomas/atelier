/**
 * O tipo MIME do arrasto de projeto.
 *
 * Um tipo próprio, e não `text/plain`: assim o canvas aceita o drop de um
 * projeto e ignora qualquer outra coisa arrastada para dentro dele — um arquivo
 * do gerenciador, um link do navegador, texto de outro app.
 */
export const PROJECT_DRAG_TYPE = 'application/x-atelier-project'

/**
 * Arquivo ou pasta arrastado de dentro da árvore.
 *
 * O payload é JSON e não só o caminho porque o destino precisa saber, ainda no
 * `drop`, se aquilo é pasta ou arquivo: um arquivo solto no canvas abre editor,
 * uma pasta vira nó de árvore. `dataTransfer` só entrega o CONTEÚDO no drop —
 * no dragover existem apenas os tipos —, então a decisão não pode depender de
 * uma ida ao disco.
 */
export const FILE_DRAG_TYPE = 'application/x-atelier-file'

export interface FileDragPayload {
  path: string
  name: string
  isDirectory: boolean
}

export function readFileDrag(data: string): FileDragPayload | null {
  try {
    const parsed = JSON.parse(data) as Partial<FileDragPayload>
    if (typeof parsed.path !== 'string' || !parsed.path) return null
    return {
      path: parsed.path,
      name: typeof parsed.name === 'string' ? parsed.name : parsed.path,
      isDirectory: parsed.isDirectory === true
    }
  } catch {
    return null
  }
}
