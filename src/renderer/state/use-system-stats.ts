/**
 * A amostra de recursos da máquina, e o pouco de histórico que o sparkline usa.
 *
 * FORA DA STORE, de propósito — é este arquivo que segura a regra. A store
 * notifica TODOS os assinantes a cada `set()`, o canvas incluído: uma amostra
 * por segundo ali re-renderizaria o canvas inteiro sessenta vezes por minuto
 * por causa de um nó de 340×300. O mesmo desvio que o progresso da varredura e
 * o estado do Git já fazem, e pelo mesmo motivo.
 *
 * O histórico também é local, e some com o nó. Isso é aceitável porque o widget
 * mede AGORA: 120 amostras × 2s são quatro minutos, o suficiente para ver o
 * pico de um build e não o suficiente para valer persistência.
 *
 * A assinatura é ref-contada do lado do main: quem monta chama `subscribe`,
 * quem desmonta chama `unsubscribe`, e o timer lá só existe enquanto houver ao
 * menos um. O canvas virtualiza por viewport, então um monitor fora da tela não
 * tem hook montado e não custa nada — como o widget de git.
 */
import { useEffect, useRef, useState } from 'react'
import type { SystemStats } from '@shared/types'

/** Espelha Constants.systemHistorySize (o main não expõe constantes ao renderer). */
export const HISTORY_SIZE = 120

/**
 * Cadências oferecidas pelo painel, e o padrão. 1s deixa a barra nervosa demais
 * para ler; 5s perde o pico de um build. Espelha Constants.systemSampleIntervalMs.
 */
export const INTERVALS = [1000, 2000, 5000] as const
export const DEFAULT_INTERVAL = 2000

/** As séries que o sparkline desenha. Cada uma é um anel de `HISTORY_SIZE`. */
export interface StatsHistory {
  cpu: number[]
  mem: number[]
}

export interface SystemStatsState {
  /** null até a primeira amostra chegar (a assinatura leva um round-trip). */
  stats: SystemStats | null
  history: StatsHistory
}

/**
 * `diskPath` vazio deixa o main escolher o `workingDirectory` do workspace, que
 * é onde os repositórios do usuário estão. Um caminho aqui é a exceção
 * explícita (`view.disk` do nó).
 */
export function useSystemStats(diskPath = '', intervalMs = DEFAULT_INTERVAL): SystemStatsState {
  const [stats, setStats] = useState<SystemStats | null>(null)

  /**
   * O histórico mora num ref, e não num state, porque ele é ATUALIZADO junto
   * com `stats`: dois `useState` dariam dois re-renders por amostra. O `stats`
   * é quem dispara o render, e o ref é lido no mesmo ciclo.
   */
  const history = useRef<StatsHistory>({ cpu: [], mem: [] })

  useEffect(() => {
    const off = window.atelier.system.onStats((sample) => {
      const h = history.current
      // `cpuPct` nulo é a primeira amostra depois de ligar o timer: ela não
      // entra no gráfico, senão o traço começaria com um degrau em zero que
      // ninguém mediu.
      if (sample.cpuPct !== null) h.cpu = push(h.cpu, sample.cpuPct)
      h.mem = push(h.mem, sample.memTotal > 0 ? (sample.memUsed / sample.memTotal) * 100 : 0)
      setStats(sample)
    })

    window.atelier.system.subscribe(diskPath, intervalMs)
    return () => {
      // O MESMO período com que assinou: é ele que identifica a entrada a
      // remover no amostrador, que pode estar servindo outros monitores.
      window.atelier.system.unsubscribe(intervalMs)
      off()
    }
  }, [diskPath, intervalMs])

  return { stats, history: history.current }
}

/** Anel: acrescenta no fim e descarta o começo. */
function push(series: number[], value: number): number[] {
  const next = series.length >= HISTORY_SIZE ? series.slice(1) : series.slice()
  next.push(value)
  return next
}
