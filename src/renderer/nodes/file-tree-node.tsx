/**
 * O nó de árvore de arquivos no canvas.
 *
 * A árvore em si é a mesma da aba Arquivos do painel (`renderer/file-tree.tsx`)
 * — aqui só entra o que é do nó: a raiz vem do conteúdo gravado e o vazio tem
 * uma mensagem que só faz sentido para um nó.
 *
 * O nó guarda apenas o rootPath. Nome, descrição e stack vêm do índice de
 * projetos, casados por caminho: campos extras gravados em FileTreeContent
 * seriam descartados na releitura, aqui e no app nativo.
 */
import type { CanvasNode, FileTreeContent } from '@shared/types'
import { FileTree } from '../file-tree'
import { store } from '../state/store'

interface Props {
  node: CanvasNode
  content: FileTreeContent
}

export function FileTreeNode({ node, content }: Props): JSX.Element {
  /**
   * Nó sem pasta oferece escolher uma, em vez de só informar que está vazio.
   * Um nó que só sabe dizer "não tenho pasta" é um beco: a única saída era
   * apagá-lo e criar outro. E existem nós assim salvos por aí — o item da dock
   * criava exatamente isto até agora.
   */
  if (!content.rootPath) {
    return (
      <div className="file-tree is-empty" data-node-interactive>
        <p>Nenhuma pasta definida para este nó.</p>
        <button type="button" className="btn" onClick={() => void chooseFolder(node.id)}>
          Escolher pasta…
        </button>
      </div>
    )
  }
  return <FileTree root={content.rootPath} />
}

async function chooseFolder(nodeId: string): Promise<void> {
  const chosen = await window.atelier.dialog.chooseDirectory()
  if (!chosen) return
  const name = chosen.split(/[\\/]/).filter(Boolean).pop() || 'Arquivos'
  await store.patchContent(nodeId, { rootPath: chosen, name })
}
