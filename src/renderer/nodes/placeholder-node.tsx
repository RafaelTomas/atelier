/**
 * Tipos de nó ainda não portados (portal, fileTree, shape, stroke, freehand).
 *
 * Renderizam um placeholder honesto em vez de sumir do canvas: o arquivo é lido
 * e regravado sem perda, então abrir um workspace do app nativo aqui e voltar
 * para lá não destrói esses nós.
 */
export function PlaceholderNode({ type }: { type: string }): JSX.Element {
  return (
    <div className="placeholder-node">
      <strong>{type}</strong>
      <span>não implementado neste porte</span>
      <small>o nó é preservado ao salvar</small>
    </div>
  )
}
