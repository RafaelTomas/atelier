/**
 * Controle de Git da toolbar, no canto superior direito.
 *
 * A pílula mostra o branch e o estado; o popover é o Git inteiro — trocar de
 * branch, pull, push, stage por arquivo, commit e histórico — sem sair do
 * canvas. A aba lateral continua existindo para quem quer a coluna larga, com
 * diff e caminhos longos legíveis.
 *
 * O projeto é o mesmo que a sidebar usa (`selectedProjectId`): dois seletores
 * de "em que repositório estou" seriam duas fontes de verdade para a mesma
 * pergunta, e o commit sairia no lugar errado.
 *
 * O popover NÃO usa a classe `.context-menu`: a regra `.context-menu button`
 * zera borda e fundo de todo botão descendente, e era ela que transformava os
 * botões de Pull/Push em texto solto.
 */
import { useEffect, useRef, useState } from 'react'
import type { GitCommitEntry } from '@shared/types'
import { truncateStart } from './paths'
import { store, useStore } from './state/store'
import { useGit } from './state/use-git'

export function GitMenu(): JSX.Element | null {
  const { projects, selectedProjectId } = useStore()
  const project = projects.find((p) => p.id === selectedProjectId) ?? null
  const path = project?.path ?? null

  const [open, setOpen] = useState(false)
  const [message, setMessage] = useState('')
  const [branches, setBranches] = useState<{ names: string[]; current: string | null } | null>(null)
  const [branchList, setBranchList] = useState(false)
  const [view, setView] = useState<'changes' | 'history'>('changes')
  const [commits, setCommits] = useState<GitCommitEntry[] | null>(null)
  const hostRef = useRef<HTMLDivElement>(null)

  const { status, error, busy, feedback, run } = useGit(open ? path : null)

  // Rascunho por projeto: trocar de projeto não pode levar junto a mensagem
  // escrita para o outro — ela seria commitada lá.
  const drafts = useRef<Record<string, string>>({})

  useEffect(() => {
    setMessage(path ? drafts.current[path] ?? '' : '')
    setBranches(null)
    setBranchList(false)
    // Commits são do projeto anterior: mantê-los mostraria o histórico errado.
    setCommits(null)
    setView('changes')
  }, [path])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (!hostRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  // Sem projeto escolhido não há o que versionar, e um botão que não faz nada
  // ocupando a toolbar é pior que a ausência dele.
  if (!project) return null

  const staged = status?.files.filter((f) => f.isStaged) ?? []
  const dirty = status?.files.length ?? 0
  const canCommit = message.trim().length > 0 && staged.length > 0 && busy === null

  const doCommit = async (): Promise<void> => {
    if (!path) return
    const ok = await run('commit', () => window.atelier.git.commit(path, message))
    if (ok) {
      // Só limpa quando passou: apagar a mensagem numa falha faria a pessoa
      // reescrever tudo.
      setMessage('')
      delete drafts.current[path]
    }
  }

  const loadHistory = async (): Promise<void> => {
    setView('history')
    if (!path) return
    const result = await window.atelier.git.log(path, 30)
    setCommits('error' in result ? [] : result.commits)
  }

  const openBranches = async (): Promise<void> => {
    if (!path) return
    if (branchList) {
      setBranchList(false)
      return
    }
    const result = await window.atelier.git.branches(path)
    if ('error' in result) return
    setBranches(result)
    setBranchList(true)
  }

  const label = error
    ? 'sem git'
    : status
      ? status.branch ?? 'HEAD solto'
      : '…'

  return (
    <div className="git-menu" ref={hostRef} onMouseDown={(e) => e.stopPropagation()}>
      <span className="git-menu-caption">GIT:</span>
      <button
        type="button"
        className={open ? 'git-menu-btn is-open' : 'git-menu-btn'}
        title={dotTitle(error, dirty, status?.operation ?? null)}
        onClick={() => setOpen((v) => !v)}
      >
        {/* O ponto é o estado num relance: limpo, sujo, ou algo errado. É a
            única coisa aqui que se lê sem parar para ler. */}
        <span className="git-menu-dot" data-state={dotKind(error, dirty, status?.operation ?? null)} />
        <span className="git-menu-icon">⑂</span>
        <span className="git-menu-label">{label}</span>
        {status && (status.ahead > 0 || status.behind > 0) && (
          <span className="git-menu-counts">
            {status.ahead > 0 && <span>↑{status.ahead}</span>}
            {status.behind > 0 && <span>↓{status.behind}</span>}
          </span>
        )}
        <span className="git-menu-caret">⌄</span>
      </button>

      {open && (
        <div className="git-popover">
          <div className="git-popover-head">
            <span className="git-popover-project" title={project.path}>
              {project.name}
            </span>
            <button
              type="button"
              className="git-popover-link"
              onClick={() => {
                setOpen(false)
                store.showProjectGit(project.id)
              }}
            >
              abrir painel
            </button>
          </div>

          {error ? (
            <p className="git-popover-empty">
              {error === 'not-a-repo'
                ? 'Este projeto não é um repositório Git.'
                : error === 'denied'
                  ? 'Sem permissão para ler este caminho.'
                  : error}
            </p>
          ) : (
            <>
              <div className="git-tabs">
                <button
                  type="button"
                  className={view === 'changes' ? 'git-tab is-active' : 'git-tab'}
                  onClick={() => setView('changes')}
                >
                  Alterações {dirty > 0 && <em>{dirty}</em>}
                </button>
                <button
                  type="button"
                  className={view === 'history' ? 'git-tab is-active' : 'git-tab'}
                  onClick={() => void loadHistory()}
                >
                  Histórico
                </button>
              </div>

              <button type="button" className="git-popover-branch" onClick={() => void openBranches()}>
                <span className="git-menu-icon">⑂</span>
                <span className="git-popover-branch-name">{status?.branch ?? 'HEAD solto'}</span>
                {status && !status.upstream && status.branch && (
                  <span className="git-tag">não publicado</span>
                )}
                <span className="git-popover-caret">{branchList ? '▾' : '▸'}</span>
              </button>

              {branchList && branches && (
                <div className="git-popover-branches">
                  {branches.names.map((name) => (
                    <button
                      key={name}
                      type="button"
                      className={name === branches.current ? 'is-current' : undefined}
                      onClick={() => {
                        setBranchList(false)
                        if (name !== branches.current) {
                          void run('branch', () => window.atelier.git.switchTo(project.path, name))
                        }
                      }}
                    >
                      {name === branches.current ? '✓ ' : '\u2007 '}
                      {name}
                    </button>
                  ))}
                  <div className="git-popover-sep" />
                  <button
                    type="button"
                    onClick={() => {
                      setBranchList(false)
                      const name = window.prompt('Nome do branch novo')
                      if (name) void run('branch', () => window.atelier.git.createBranch(project.path, name))
                    }}
                  >
                    Criar branch…
                  </button>
                </div>
              )}

              {status?.operation && (
                <p className="git-popover-warn">
                  {status.operation} em andamento — termine num terminal antes de commitar.
                </p>
              )}

              <div className="git-popover-row">
                <button
                  type="button"
                  className="btn"
                  disabled={busy !== null || !status}
                  onClick={() => void run('pull', () => window.atelier.git.pull(project.path))}
                  title="Trazer os commits do remoto (só fast-forward)"
                >
                  {busy === 'pull' ? 'Puxando…' : 'Pull'}
                </button>
                <button
                  type="button"
                  className="btn"
                  disabled={busy !== null || !status}
                  onClick={() => void run('push', () => window.atelier.git.push(project.path))}
                  title={status?.upstream ? 'Enviar os commits locais' : 'Publicar este branch em origin'}
                >
                  {busy === 'push' ? 'Enviando…' : status?.upstream ? 'Push' : 'Publicar'}
                </button>
              </div>

              {view === 'history' ? (
                <ul className="git-popover-log">
                  {commits === null && <li className="git-popover-empty">Carregando…</li>}
                  {commits?.length === 0 && <li className="git-popover-empty">Nenhum commit ainda.</li>}
                  {commits?.map((c) => (
                    <li key={c.hash} className="git-popover-commit">
                      <span className="git-popover-commit-subject" title={c.subject}>
                        {c.subject}
                      </span>
                      <span className="git-popover-commit-meta">
                        <code>{c.hash}</code> {c.relativeDate}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <>
                  <div className="git-popover-stage">
                    <span>
                      {staged.length > 0
                        ? `${staged.length} preparado(s)`
                        : dirty > 0
                          ? `${dirty} alteração(ões)`
                          : 'árvore limpa'}
                    </span>
                    {dirty > 0 && (
                      <button
                        type="button"
                        className="git-popover-link"
                        disabled={busy !== null}
                        onClick={() =>
                          void run('stage', () =>
                            staged.length === dirty
                              ? window.atelier.git.unstageAll(project.path)
                              : window.atelier.git.stageAll(project.path)
                          )
                        }
                      >
                        {staged.length === dirty ? 'tirar tudo' : 'preparar tudo'}
                      </button>
                    )}
                  </div>

                  {dirty > 0 && (
                    <ul className="git-popover-files">
                      {status?.files.map((file) => (
                        <li key={file.path} className="git-popover-file">
                          <span
                            className="git-code"
                            data-status={file.isConflicted ? 'conflict' : file.isUntracked ? 'new' : 'mod'}
                          >
                            {file.isConflicted ? '!' : file.isUntracked ? '?' : (file.isStaged ? file.index : file.worktree).trim() || 'M'}
                          </span>
                          <span className="git-popover-file-path" title={file.path}>
                            {truncateStart(file.path, 32)}
                          </span>
                          <button
                            type="button"
                            className="git-popover-file-btn"
                            disabled={busy !== null}
                            title={file.isStaged ? 'Tirar do stage' : 'Preparar para o commit'}
                            onClick={() =>
                              void run('stage', () =>
                                file.isStaged
                                  ? window.atelier.git.unstage(project.path, [file.path])
                                  : window.atelier.git.stage(project.path, [file.path])
                              )
                            }
                          >
                            {file.isStaged ? '−' : '+'}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}

                  <textarea
                    className="git-message"
                    value={message}
                    rows={2}
                    placeholder={staged.length === 0 ? 'Prepare arquivos para commitar…' : 'Mensagem do commit'}
                    onChange={(e) => {
                      setMessage(e.target.value)
                      drafts.current[project.path] = e.target.value
                    }}
                    onKeyDown={(e) => {
                      // O popover fecha no Esc; sem isto a tecla só sairia do campo.
                      if (e.key === 'Escape') setOpen(false)
                      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && canCommit) void doCommit()
                    }}
                  />

                  <button
                    type="button"
                    className="btn is-primary git-popover-commit-btn"
                    disabled={!canCommit}
                    onClick={() => void doCommit()}
                    title={staged.length === 0 ? 'prepare pelo menos um arquivo' : 'Commitar · ⌘/Ctrl+Enter'}
                  >
                    {busy === 'commit' ? 'Commitando…' : `Commit${staged.length > 0 ? ` (${staged.length})` : ''}`}
                  </button>
                </>
              )}
            </>
          )}

          {feedback && (
            <p className={feedback.ok ? 'git-popover-feedback' : 'git-popover-feedback is-error'}>
              {feedback.text}
            </p>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * Cor do ponto de estado. Uma operação pendente (merge/rebase) ganha de tudo:
 * é o estado em que um commit distraído faz mais estrago.
 */
function dotKind(error: string | null, dirty: number, operation: string | null): string {
  if (error) return 'off'
  if (operation) return 'warn'
  return dirty > 0 ? 'dirty' : 'clean'
}

function dotTitle(error: string | null, dirty: number, operation: string | null): string {
  if (error) return error === 'not-a-repo' ? 'não é um repositório Git' : 'Git indisponível'
  if (operation) return `${operation} em andamento`
  return dirty > 0 ? `${dirty} alteração(ões) não commitada(s)` : 'árvore limpa'
}
