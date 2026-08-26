/**
 * Estado do Git de um projeto, compartilhado pela aba lateral e pelo botão da
 * toolbar.
 *
 * Existe como hook, e não na store global, pelo mesmo motivo do progresso da
 * varredura: o status é relido a cada poucos segundos, e cada set() da store
 * notifica TODOS os assinantes — o canvas junto. Aqui o re-render fica contido
 * em quem usa o hook.
 *
 * Custo aceito: dois consumidores montados ao mesmo tempo (a aba aberta e o
 * botão da toolbar) fazem dois `git status` por ciclo. É uma leitura barata,
 * feita com GIT_OPTIONAL_LOCKS=0, e o preço de evitá-la seria justamente pôr o
 * status na store.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
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

export function useGit(path: string | null): UseGit {
  const [status, setStatus] = useState<GitStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<GitBusy>(null)
  const [feedback, setFeedback] = useState<GitFeedback | null>(null)

  // O intervalo é montado uma vez; `busy` muda a cada ação. Um ref evita
  // recriar o timer (e reiniciar a contagem) a cada clique.
  const busyRef = useRef<GitBusy>(null)
  busyRef.current = busy

  // Trocar de projeto durante um status em voo: a resposta do anterior chegaria
  // depois e sobrescreveria a do novo. O contador descarta a resposta velha.
  const generation = useRef(0)

  const refresh = useCallback(
    async (quiet = false): Promise<void> => {
      if (!path) return
      const gen = ++generation.current
      if (!quiet) setBusy('status')
      const result = await window.atelier.git.status(path)
      if (gen !== generation.current) return
      if ('error' in result) {
        setStatus(null)
        setError(result.error)
      } else {
        setStatus(result)
        setError(null)
      }
      if (!quiet) setBusy(null)
    },
    [path]
  )

  useEffect(() => {
    generation.current++
    setStatus(null)
    setError(null)
    setFeedback(null)
    if (path) void refresh()
  }, [path, refresh])

  useEffect(() => {
    if (!path) return
    const id = setInterval(() => {
      // O polling não acende o spinner nem atropela uma ação em andamento — um
      // status no meio de um push mostraria um estado intermediário que já não
      // vale.
      if (!busyRef.current) void refresh(true)
    }, POLL_MS)
    return () => clearInterval(id)
  }, [path, refresh])

  useEffect(() => {
    if (!feedback) return
    const t = setTimeout(() => setFeedback(null), 6000)
    return () => clearTimeout(t)
  }, [feedback])

  const run = useCallback(
    async (kind: GitBusy, action: () => Promise<{ ok: boolean; message: string }>): Promise<boolean> => {
      setBusy(kind)
      setFeedback(null)
      const result = await action()
      setFeedback({ ok: result.ok, text: result.message })
      await refresh(true)
      setBusy(null)
      return result.ok
    },
    [refresh]
  )

  return { status, error, busy, feedback, setFeedback, refresh, run }
}
