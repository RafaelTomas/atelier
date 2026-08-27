/**
 * Estado do Git de um projeto, compartilhado por todos os consumidores.
 *
 * Existe como hook, e não na store global, pelo mesmo motivo do progresso da
 * varredura: o status é relido a cada poucos segundos, e cada set() da store
 * notifica TODOS os assinantes — o canvas junto. Aqui o re-render fica contido
 * em quem usa o hook.
 *
 * O POLLING, porém, é compartilhado por caminho. Antes cada consumidor tinha o
 * próprio intervalo, e dois deles (a coluna aberta e o botão da toolbar) já
 * custavam dois `git status` por ciclo. Com os widgets de canvas isso deixou de
 * ser um preço fixo: nada impede quatro nós de git na tela, e quatro deles no
 * mesmo repositório dariam quatro leituras idênticas a cada 4s. O cache abaixo
 * dá UMA leitura por caminho, com contagem de assinantes — o último a sair
 * desliga o timer.
 *
 * O que continua LOCAL a cada consumidor: `busy` e `feedback`. Eles descrevem a
 * ação que AQUELE painel disparou; compartilhá-los faria o spinner do commit de
 * um nó aparecer em todos os outros.
 *
 * Nó desmontado não assina: o canvas virtualiza por viewport, então um widget
 * fora da tela não tem hook montado e não paga polling. É de graça, e é a
 * mitigação de custo que os widgets pediam.
 */
import { useCallback, useEffect, useState } from 'react'
import type { GitStatus } from '@shared/types'

/**
 * Releitura periódica. O git não avisa ninguém quando um arquivo muda, e um
 * agente rodando num nó do canvas edita arquivos o tempo todo — sem isto o
 * painel mostraria um retrato de minutos atrás.
 */
const POLL_MS = 4000

export type GitBusy =
  | null
  | 'status'
  | 'commit'
  | 'pull'
  | 'push'
  | 'fetch'
  | 'stage'
  | 'discard'
  | 'branch'

export interface GitFeedback {
  ok: boolean
  text: string
}

export interface UseGit {
  status: GitStatus | null
  error: string | null
  busy: GitBusy
  feedback: GitFeedback | null
  setFeedback: (f: GitFeedback | null) => void
  refresh: (quiet?: boolean) => Promise<void>
  /** Trava, roda, mostra o resultado e relê. Devolve se a ação passou. */
  run: (kind: GitBusy, action: () => Promise<{ ok: boolean; message: string }>) => Promise<boolean>
}

// ─── Cache por caminho ────────────────────────────────────────────────────────

interface Entry {
  status: GitStatus | null
  error: string | null
  subscribers: Set<() => void>
  timer: ReturnType<typeof setInterval> | null
  /**
   * Quantos consumidores estão no meio de uma ação. O polling não atropela uma
   * delas: um status no meio de um push mostraria um estado intermediário que
   * já não vale.
   */
  busyCount: number
  /**
   * Uma leitura em voo, se houver. Duas montagens simultâneas no mesmo caminho
   * (a coluna e um widget, abertos juntos) compartilham a MESMA promessa em vez
   * de disparar dois `git status`.
   */
  inflight: Promise<void> | null
  /** Descarta a resposta de uma leitura que ficou obsoleta. */
  generation: number
}

const cache = new Map<string, Entry>()

function entryFor(path: string): Entry {
  let entry = cache.get(path)
  if (!entry) {
    entry = {
      status: null,
      error: null,
      subscribers: new Set(),
      timer: null,
      busyCount: 0,
      inflight: null,
      generation: 0
    }
    cache.set(path, entry)
  }
  return entry
}

/**
 * `force` pula a leitura em voo e começa outra.
 *
 * É o que separa "quero o status" de "MUDEI o repositório e quero o status": uma
 * leitura disparada antes do commit ainda pode estar no ar quando ele termina, e
 * compartilhá-la devolveria o estado de antes — a árvore de trabalho suja que o
 * commit acabou de limpar. A geração descarta a resposta velha.
 */
function readStatus(path: string, force = false): Promise<void> {
  const entry = entryFor(path)
  if (entry.inflight && !force) return entry.inflight
  const gen = ++entry.generation
  const p = window.atelier.git
    .status(path)
    .then((result) => {
      // Só a leitura mais recente escreve: uma resposta atrasada de antes de um
      // commit sobrescreveria o estado de depois dele.
      if (gen !== entry.generation) return
      if ('error' in result) {
        entry.status = null
        entry.error = result.error
      } else {
        entry.status = result
        entry.error = null
      }
      for (const notify of entry.subscribers) notify()
    })
    .finally(() => {
      if (entry.inflight === p) entry.inflight = null
    })
  entry.inflight = p
  return p
}

export function useGit(path: string | null): UseGit {
  const [, bump] = useState(0)
  const [busy, setBusy] = useState<GitBusy>(null)
  const [feedback, setFeedback] = useState<GitFeedback | null>(null)

  // Assina o caminho e mantém o timer vivo enquanto houver alguém olhando.
  useEffect(() => {
    if (!path) return
    const entry = entryFor(path)
    const notify = (): void => bump((n) => n + 1)
    entry.subscribers.add(notify)

    if (!entry.timer) {
      entry.timer = setInterval(() => {
        if (entry.busyCount === 0) void readStatus(path)
      }, POLL_MS)
    }
    // Cada montagem relê: o cache pode ser de minutos atrás, e mostrar um
    // retrato velho por até 4s é justamente o que o polling existe para evitar.
    void readStatus(path)

    return () => {
      entry.subscribers.delete(notify)
      if (entry.subscribers.size > 0) return
      // Último a sair apaga a luz. O status fica no cache: a próxima montagem
      // no mesmo caminho pinta com ele enquanto a releitura não volta.
      if (entry.timer) clearInterval(entry.timer)
      entry.timer = null
    }
  }, [path])

  // Trocar de projeto zera o que era do anterior — `busy` e `feedback` são desta
  // montagem, e descrevem uma ação feita no repositório que acabou de sair.
  useEffect(() => {
    setBusy(null)
    setFeedback(null)
  }, [path])

  const refresh = useCallback(
    async (quiet = false): Promise<void> => {
      if (!path) return
      if (!quiet) setBusy('status')
      // Botão de reler: é pedido explícito, e uma leitura em voo pode ser
      // justamente a que o usuário achou velha.
      await readStatus(path, true)
      if (!quiet) setBusy(null)
    },
    [path]
  )

  useEffect(() => {
    if (!feedback) return
    const t = setTimeout(() => setFeedback(null), 6000)
    return () => clearTimeout(t)
  }, [feedback])

  // Enquanto ESTE consumidor está no meio de uma ação, o caminho conta como
  // ocupado e o timer compartilhado não relê. O cleanup cobre a desmontagem no
  // meio da ação — sem ele o caminho ficaria ocupado para sempre e o polling
  // nunca voltaria.
  useEffect(() => {
    if (!path || busy === null) return
    const entry = entryFor(path)
    entry.busyCount++
    return () => {
      entry.busyCount--
    }
  }, [busy, path])

  const run = useCallback(
    async (kind: GitBusy, action: () => Promise<{ ok: boolean; message: string }>): Promise<boolean> => {
      setBusy(kind)
      setFeedback(null)
      const result = await action()
      setFeedback({ ok: result.ok, text: result.message })
      // A ação mudou o repositório: a releitura vale para TODOS os assinantes
      // daquele caminho, não só para quem clicou.
      if (path) await readStatus(path, true)
      setBusy(null)
      return result.ok
    },
    [path]
  )

  const entry = path ? cache.get(path) : undefined
  return {
    status: entry?.status ?? null,
    error: entry?.error ?? null,
    busy,
    feedback,
    setFeedback,
    refresh,
    run
  }
}
