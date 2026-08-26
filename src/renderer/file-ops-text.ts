/**
 * Motivo de recusa → frase para o usuário.
 *
 * O main devolve um CÓDIGO, nunca a mensagem do sistema: o texto do fs revela a
 * existência e o nome de caminhos fora do escopo permitido. Traduzir é assunto
 * do renderer.
 *
 * Módulo próprio porque os dois consumidores não têm relação entre si — a
 * árvore de arquivos e o nó de editor. Importar a tabela de dentro do
 * componente de árvore arrastaria o componente inteiro para o editor.
 */
import type { FileOpError } from '@shared/types'

export const FILE_OP_TEXT: Record<FileOpError, string> = {
  missing: 'este arquivo não existe mais',
  denied: 'sem permissão para este arquivo',
  'too-large': 'arquivo grande demais para o editor',
  binary: 'isto parece um binário, não texto',
  exists: 'já existe um item com esse nome',
  'not-a-file': 'isto não é um arquivo',
  error: 'não foi possível concluir a operação'
}
