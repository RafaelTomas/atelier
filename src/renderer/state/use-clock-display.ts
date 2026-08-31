/**
 * A assinatura de apresentação de um relógio montado.
 *
 * FORA da store, pela mesma razão de `use-system-stats.ts`: a store notifica
 * TODOS os assinantes a cada `set()`, o canvas incluído, e um valor que muda a
 * cada segundo ali re-renderizaria a árvore de nós inteira por causa de alguns
 * caracteres de um mostrador.
 *
 * E, ao contrário do monitor, a assinatura aqui é SÓ de escrita visual. O
 * monitor pode desligar o amostrador quando ninguém está montado, porque uma
 * amostra que ninguém vê não serve para nada. Um relógio, não: ele pode ter um
 * botão ligado por cabo, e a virtualização do canvas não pode desarmar um timer
 * que tem ação conectada. Por isso o hook não liga nem desliga nada — quem
 * conta e quem dispara é o coordenador, para o workspace inteiro. Montar apenas
 * diz PARA ONDE escrever; desmontar apenas para de escrever.
 */
import { useEffect, useRef } from 'react'
import type { UUID } from '@shared/types'
import { clockCoordinator } from './clock-coordinator'

/**
 * Devolve a ref do contêiner do mostrador. O widget a pendura no elemento que
 * envolve os `data-clock-readout` / `data-clock-detail` / `data-clock-progress`
 * — é dentro dele que o coordenador acha, uma vez só, o que vai reescrever a
 * cada segundo.
 */
export function useClockDisplay(
  nodeId: UUID,
  mode: string,
  editing: boolean
): React.RefObject<HTMLDivElement> {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    clockCoordinator.register(nodeId, ref.current)
    return () => clockCoordinator.unregister(nodeId)
    // Estes são os dois únicos estados que trocam a estrutura interna do
    // mostrador. Um MutationObserver também veria o `innerHTML` que o próprio
    // coordenador escreve a cada segundo e, como seu callback é assíncrono, uma
    // flag síncrona não conseguiria distinguir essa pintura de um render React.
  }, [nodeId, mode, editing])

  return ref
}
