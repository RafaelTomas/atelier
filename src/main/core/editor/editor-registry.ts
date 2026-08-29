/**
 * Registro `nodeId → estado do editor` — o que o agente precisa saber sobre o
 * arquivo que o usuário está olhando.
 *
 * O buffer do CodeMirror vive no renderer, e o main não tem como perguntar: é a
 * mesma parede que o portal-registry.ts descreve. Só que aqui o round-trip
 * (main → renderer → editor → renderer → main) não se paga, porque o dado é
 * minúsculo e muda a cada tecla — então o renderer EMPURRA, com debounce, e o
 * main guarda a última versão.
 *
 * Sem este registro, um `atelier editor read` num arquivo com alteração
 * pendente devolveria a versão morta do disco, e o agente trabalharia em cima
 * do que o usuário acabou de apagar.
 *
 * Como o portal-registry, este módulo NÃO importa `electron`: é um Map em
 * memória, e é isso que o smoke headless consegue exercitar. Estado derivado do
 * renderer nunca é gravado no workspace.json — some junto com a sessão, que é o
 * único jeito de ele não virar mentira na próxima abertura.
 */
import type { UUID } from '@shared/types'

export interface EditorState {
  /** Caminho absoluto do arquivo aberto no nó. */
  path: string
  /** O buffer difere do disco: gravar por baixo dele destrói trabalho. */
  dirty: boolean
  /** Linhas 1-based do que está selecionado. null = só cursor, sem seleção. */
  selection: { from: number; to: number } | null
  /** Linha 1-based onde o cursor está. */
  cursorLine: number
  /**
   * Texto do buffer — SÓ enquanto sujo. Com o arquivo limpo o main lê do disco,
   * que é a fonte da verdade e já tem o teto de MAX_TEXT_BYTES; guardar uma
   * segunda cópia seria dois lugares para divergirem.
   */
  buffer: string | null
}

const editors = new Map<UUID, EditorState>()

/**
 * Chamado pelo renderer a cada mudança de documento ou de seleção (com
 * debounce) e em todo save. Idempotente: sempre substitui a entrada inteira, o
 * que é mais barato e mais honesto do que casar campo a campo.
 */
export function setEditorState(nodeId: UUID, state: EditorState): void {
  // O buffer só existe enquanto sujo — e esta é a trava, não o remetente: um
  // push limpo carregando texto deixaria uma cópia velha viva no main até o
  // desmonte do nó.
  editors.set(nodeId, state.dirty ? state : { ...state, buffer: null })
}

/** Desmonte do nó (zoom, virtualização, remoção) ou troca de arquivo. */
export function clearEditorState(nodeId: UUID): void {
  editors.delete(nodeId)
}

/**
 * O estado conhecido, ou null.
 *
 * null NÃO significa "arquivo limpo": significa "não sei" — nó ainda não
 * montado, fora da tela, ou renderer sem janela. Quem imprime tem de dizer isso
 * com a ausência do sufixo, nunca afirmando que está salvo.
 */
export function editorState(nodeId: UUID): EditorState | null {
  return editors.get(nodeId) ?? null
}

/** Só para teste headless: esvazia o registro entre casos. */
export function resetEditors(): void {
  editors.clear()
}
