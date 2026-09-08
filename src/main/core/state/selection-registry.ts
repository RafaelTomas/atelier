/**
 * O projeto selecionado na aplicação, espelhado no main.
 *
 * Existe por causa de um campo: `WidgetContent.projectId` é `null` quando o
 * painel de git (ou o de projetos) SEGUE a seleção global em vez de fixar um
 * repositório — e esse é o estado padrão de todo painel criado pela dock. A
 * seleção em si mora na store do renderer, que é o lugar certo: ela muda quando
 * o usuário clica num projeto da rail, dezenas de vezes por sessão, e nada
 * disso pertence ao disco.
 *
 * Só que o inventário do agente é montado no MAIN. Sem este espelho, a linha do
 * painel de git responderia "segue a seleção global" e pa: o agente saberia que
 * existe um repositório e não qual. A referência é justamente o que ele precisa
 * — o resto ele faz com `git` no shell dele.
 *
 * Mesma disciplina do editor-registry: o renderer EMPURRA, o main guarda a
 * última versão, nada é gravado no workspace.json, e o módulo não importa
 * `electron` — é um valor em memória, e é o que o smoke headless exercita.
 * `null` significa "não sei ou nada selecionado", nunca um palpite.
 */
import type { UUID } from '@shared/types'

let selected: UUID | null = null

/** Chamado pelo renderer a cada `selectProject`, e no boot da janela. */
export function setSelectedProject(id: UUID | null): void {
  selected = id
}

export function selectedProject(): UUID | null {
  return selected
}

/** Só para teste headless: volta ao estado de "não sei". */
export function resetSelectedProject(): void {
  selected = null
}
