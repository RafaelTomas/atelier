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
import type { FileTreeContent } from '@shared/types'
import { FileTree } from '../file-tree'

interface Props {
  content: FileTreeContent
}

export function FileTreeNode({ content }: Props): JSX.Element {
  if (!content.rootPath) {
    return <div className="file-tree is-empty">Nenhuma pasta definida para este nó.</div>
  }
  return <FileTree root={content.rootPath} />
}
