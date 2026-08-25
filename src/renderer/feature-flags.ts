/**
 * Interruptores de features que existem no código mas ainda não vão para a
 * frente do usuário.
 *
 * Um flag e não `git revert`: o caminho todo — nó Scanner, prompt inicial, fila
 * em `atelier projects list --pending`, escrita por `atelier projects describe`
 * — está implementado e testado. O que falta é confiança no resultado, e isso
 * se ganha usando, não reescrevendo.
 */

/**
 * Descrever projetos com um agente. Desligado até a experiência estar redonda:
 * com a configuração padrão de permissões o agente ainda para para pedir
 * aprovação no primeiro comando, e o usuário vê um nó que não faz nada.
 *
 * Ligar de novo é trocar isto para `true` — nada mais. Os dois pontos de
 * entrada (o menu ⋮ do painel e o "Descrever automaticamente" do diálogo de
 * scan) leem esta constante.
 */
export const DESCRIBE_PROJECTS_ENABLED = false
