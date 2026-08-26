/**
 * Aba Git: o console de versionamento do projeto selecionado.
 *
 * Segue a mesma regra da aba Arquivos — quem escolhe o projeto é a aba
 * Projetos, e este painel só mostra o dele. Um seletor próprio aqui seria uma
 * segunda fonte de verdade para "em que projeto estou".
 *
 * O status NÃO mora na store. Ele muda a cada ação e a cada polling, e cada
 * set() da store notifica todos os assinantes, canvas incluído — a mesma razão
 * pela qual o progresso da varredura ficou local no painel de projetos.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { GitCommitEntry, GitFileChange } from '@shared/types'
import { IconReload } from '../icons'
import { truncateStart } from '../paths'
import { store, useStore } from '../state/store'
import { useGit } from '../state/use-git'

export function GitPanel(): JSX.Element {
  const { projects, selectedProjectId } = useStore()
  const project = projects.find((p) => p.id === selectedProjectId) ?? null
  const path = project?.path ?? null

  const { status, error, busy, feedback, setFeedback, refresh, run } = useGit(path)
  const [message, setMessage] = useState('')
  const [view, setView] = useState<'changes' | 'history'>('changes')
  const [commits, setCommits] = useState<GitCommitEntry[] | null>(null)
  const [branchMenu, setBranchMenu] = useState<{ names: string[]; current: string | null } | null>(null)
  const [diffFile, setDiffFile] = useState<{ path: string; staged: boolean; patch: string } | null>(null)

  // Cada projeto tem a sua caixa de mensagem. Sem isto, trocar de projeto
  // levaria junto a mensagem escrita para o outro — e ela seria commitada lá.
  const drafts = useRef<Record<string, string>>({})

  // Troca de projeto: carrega o rascunho dele e zera o que era do anterior.
  // `diffFile` e `commits` pertencem ao projeto antigo e não podem sobreviver;
  // status e feedback são zerados pelo próprio hook.
  useEffect(() => {
    setCommits(null)
    setDiffFile(null)
    setBranchMenu(null)
    setMessage(path ? drafts.current[path] ?? '' : '')
  }, [path])

  useEffect(() => {
    if (!branchMenu) return
    const close = (): void => setBranchMenu(null)
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [branchMenu])

  const staged = useMemo(() => status?.files.filter((f) => f.isStaged) ?? [], [status])
  const unstaged = useMemo(
    () => status?.files.filter((f) => !f.isStaged || f.worktree !== ' ') ?? [],
    [status]
  )
  const conflicted = useMemo(() => status?.files.filter((f) => f.isConflicted) ?? [], [status])

  if (!project) {
    return (
      <div className="project-empty">
        <p>Nenhum projeto selecionado.</p>
        <p className="files-hint">Escolha um projeto para ver o Git dele.</p>
        <button type="button" className="btn" onClick={() => store.setSidebarTab('projetos')}>
          Ver projetos
        </button>
      </div>
    )
  }

  const doCommit = async (): Promise<void> => {
    if (!path) return
    const ok = await run('commit', () => window.atelier.git.commit(path, message))
    if (ok) {
      // Só limpa quando o commit passou: apagar a mensagem numa falha faria a
      // pessoa reescrever tudo.
      setMessage('')
      delete drafts.current[path]
    }
  }

  const openDiff = async (file: GitFileChange, isStaged: boolean): Promise<void> => {
    if (!path) return
    if (diffFile?.path === file.path && diffFile.staged === isStaged) {
      setDiffFile(null)
      return
    }
    const result = await window.atelier.git.diff(path, file.path, isStaged)
    if ('error' in result) {
      setFeedback({ ok: false, text: result.error })
      return
    }
    setDiffFile({ path: file.path, staged: isStaged, patch: result.patch })
  }

  const loadHistory = async (): Promise<void> => {
    if (!path) return
    setView('history')
    const result = await window.atelier.git.log(path, 40)
    if ('error' in result) {
      setFeedback({ ok: false, text: result.error })
      setCommits([])
      return
    }
    setCommits(result.commits)
  }

  const openBranches = async (): Promise<void> => {
    if (!path) return
    if (branchMenu) {
      setBranchMenu(null)
      return
    }
    const result = await window.atelier.git.branches(path)
    if ('error' in result) {
      setFeedback({ ok: false, text: result.error })
      return
    }
    setBranchMenu(result)
  }

  const discardFile = async (file: GitFileChange): Promise<void> => {
    if (!path) return
    const label = file.isUntracked ? `apagar ${file.path}?` : `descartar as alterações em ${file.path}?`
    // Confirmação por window.confirm: é a única ação daqui que perde trabalho
    // sem volta, e o custo de um diálogo é menor que o de um clique errado.
    if (!window.confirm(`Isto não tem desfazer — ${label}`)) return
    await run('discard', () =>
      window.atelier.git.discard(
        path,
        file.isUntracked ? [] : [file.path],
        file.isUntracked ? [file.path] : []
      )
    )
  }

  // Repositório ausente ou inacessível: o painel diz o que fazer, e nada mais.
  if (error) {
    return (
      <>
        <GitHeader project={project.name} />
        <div className="project-empty">
          {error === 'not-a-repo' ? (
            <>
              <p>Este projeto não é um repositório Git.</p>
              <p className="files-hint">
                Rode <code>git init</code> num terminal para começar a versioná-lo.
              </p>
              <button type="button" className="btn" onClick={() => store.openNewTerminal(null, project.path)}>
                Abrir terminal aqui
              </button>
            </>
          ) : error === 'denied' ? (
            <p>Sem permissão para ler este caminho.</p>
          ) : (
            <p>{error}</p>
          )}
        </div>
      </>
    )
  }

  const canCommit = message.trim().length > 0 && staged.length > 0 && busy === null
  const inOperation = status?.operation != null

  return (
    <>
      <GitHeader
        project={project.name}
        busy={busy === 'status'}
        onRefresh={() => void refresh()}
      />

      <div className="git-branchline">
        <button
          type="button"
          className="git-branch"
          title={status?.upstream ? `segue ${status.upstream}` : 'este branch ainda não foi publicado'}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={() => void openBranches()}
          disabled={!status || busy !== null}
        >
          <span className="git-branch-icon">⑂</span>
          <span className="git-branch-name">{status?.branch ?? 'HEAD solto'}</span>
        </button>

        {status && (status.ahead > 0 || status.behind > 0) && (
          <span className="git-counts" title={`${status.ahead} para enviar · ${status.behind} para receber`}>
            {status.ahead > 0 && <span>↑{status.ahead}</span>}
            {status.behind > 0 && <span>↓{status.behind}</span>}
          </span>
        )}

        {status && !status.upstream && status.branch && <span className="git-tag">não publicado</span>}

        {branchMenu && (
          <div className="git-branch-menu" onMouseDown={(e) => e.stopPropagation()}>
            <div className="git-branch-menu-title">Trocar de branch</div>
            {branchMenu.names.map((name) => (
              <button
                key={name}
                type="button"
                className={name === branchMenu.current ? 'is-current' : undefined}
                onClick={() => {
                  setBranchMenu(null)
                  if (name !== branchMenu.current) {
                    void run('branch', () => window.atelier.git.switchTo(project.path, name))
                  }
                }}
              >
                {name === branchMenu.current ? '✓ ' : '  '}
                {name}
              </button>
            ))}
            <div className="context-menu-sep" />
            <button
              type="button"
              onClick={() => {
                setBranchMenu(null)
                const name = window.prompt('Nome do branch novo')
                if (name) void run('branch', () => window.atelier.git.createBranch(project.path, name))
              }}
            >
              Criar branch…
            </button>
          </div>
        )}
      </div>

      <div className="git-actions">
        <button
          type="button"
          className="btn"
          disabled={busy !== null || !status}
          onClick={() => void run('fetch', () => window.atelier.git.fetch(project.path))}
          title="Consultar o remoto sem alterar nada"
        >
          Buscar
        </button>
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

      {inOperation && (
        <p className="git-warning">
          {status?.operation} em andamento — termine num terminal antes de commitar aqui.
        </p>
      )}

      {feedback && <p className={feedback.ok ? 'git-feedback' : 'git-feedback is-error'}>{feedback.text}</p>}

      <div className="git-tabs">
        <button
          type="button"
          className={view === 'changes' ? 'git-tab is-active' : 'git-tab'}
          onClick={() => setView('changes')}
        >
          Alterações {status && status.files.length > 0 && <em>{status.files.length}</em>}
        </button>
        <button
          type="button"
          className={view === 'history' ? 'git-tab is-active' : 'git-tab'}
          onClick={() => void loadHistory()}
        >
          Histórico
        </button>
      </div>

      {view === 'history' ? (
        <ul className="git-log">
          {commits === null && <li className="git-empty">Carregando…</li>}
          {commits?.length === 0 && <li className="git-empty">Nenhum commit ainda.</li>}
          {commits?.map((c) => (
            <li key={c.hash} className="git-commit">
              <span className="git-commit-subject" title={c.subject}>
                {c.subject}
              </span>
              <span className="git-commit-meta">
                <code>{c.hash}</code> {c.author} · {c.relativeDate}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <div className="git-changes">
          {conflicted.length > 0 && (
            <p className="git-warning">
              {conflicted.length} arquivo(s) em conflito — resolva antes de commitar.
            </p>
          )}

          <FileSection
            title="Staged"
            files={staged}
            count={staged.length}
            emptyHint="Nada preparado para o commit."
            action={{
              label: 'Tirar tudo',
              disabled: staged.length === 0 || busy !== null,
              run: () => void run('stage', () => window.atelier.git.unstageAll(project.path))
            }}
            rowAction={{
              label: '−',
              title: 'Tirar do stage',
              run: (f) => void run('stage', () => window.atelier.git.unstage(project.path, [f.path]))
            }}
            onOpenDiff={(f) => void openDiff(f, true)}
            openDiff={diffFile?.staged === true ? diffFile : null}
            busy={busy !== null}
          />

          <FileSection
            title="Alterações"
            files={unstaged}
            count={unstaged.length}
            emptyHint="Árvore limpa."
            action={{
              label: 'Preparar tudo',
              disabled: unstaged.length === 0 || busy !== null,
              run: () => void run('stage', () => window.atelier.git.stageAll(project.path))
            }}
            rowAction={{
              label: '+',
              title: 'Preparar para o commit',
              run: (f) => void run('stage', () => window.atelier.git.stage(project.path, [f.path]))
            }}
            onDiscard={(f) => void discardFile(f)}
            onOpenDiff={(f) => void openDiff(f, false)}
            openDiff={diffFile?.staged === false ? diffFile : null}
            busy={busy !== null}
          />

          <div className="git-commit-box">
            <textarea
              className="git-message"
              value={message}
              placeholder={staged.length === 0 ? 'Prepare arquivos para commitar…' : 'Mensagem do commit'}
              rows={3}
              onChange={(e) => {
                setMessage(e.target.value)
                drafts.current[project.path] = e.target.value
              }}
              onKeyDown={(e) => {
                // Cmd/Ctrl+Enter commita — o atalho que todo cliente de git tem.
                if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && canCommit) void doCommit()
              }}
            />
            <button
              type="button"
              className="btn is-primary git-commit-btn"
              disabled={!canCommit}
              onClick={() => void doCommit()}
              title={
                staged.length === 0
                  ? 'prepare pelo menos um arquivo'
                  : 'Commitar · ⌘/Ctrl+Enter'
              }
            >
              {busy === 'commit' ? 'Commitando…' : `Commit${staged.length > 0 ? ` (${staged.length})` : ''}`}
            </button>
          </div>
        </div>
      )}
    </>
  )
}

function GitHeader({
  project,
  busy,
  onRefresh
}: {
  project: string
  busy?: boolean
  onRefresh?: () => void
}): JSX.Element {
  return (
    <div className="sidebar-header">
      <span className="files-title">{project}</span>
      {onRefresh && (
        <div className="sidebar-header-actions">
          <button
            type="button"
            className={busy ? 'icon-btn ghost-btn is-active' : 'icon-btn ghost-btn'}
            onClick={onRefresh}
            title="Reler o status"
            disabled={busy}
          >
            <IconReload size={15} />
          </button>
        </div>
      )}
    </div>
  )
}

interface RowAction {
  label: string
  title: string
  run: (file: GitFileChange) => void
}

interface FileSectionProps {
  title: string
  files: GitFileChange[]
  count: number
  emptyHint: string
  action: { label: string; disabled: boolean; run: () => void }
  rowAction: RowAction
  onDiscard?: (file: GitFileChange) => void
  onOpenDiff: (file: GitFileChange) => void
  openDiff: { path: string; patch: string } | null
  busy: boolean
}

function FileSection({
  title,
  files,
  count,
  emptyHint,
  action,
  rowAction,
  onDiscard,
  onOpenDiff,
  openDiff,
  busy
}: FileSectionProps): JSX.Element {
  return (
    <section className="git-section">
      <div className="git-section-head">
        <span>
          {title} {count > 0 && <em className="sidebar-count">{count}</em>}
        </span>
        <button type="button" className="icon-btn ghost-btn git-section-action" disabled={action.disabled} onClick={action.run}>
          {action.label}
        </button>
      </div>

      {files.length === 0 ? (
        <p className="git-empty">{emptyHint}</p>
      ) : (
        <ul className="git-files">
          {files.map((file) => (
            <li key={`${title}:${file.path}`}>
              <div className={file.isConflicted ? 'git-file is-conflicted' : 'git-file'}>
                <button
                  type="button"
                  className="git-file-name"
                  title={file.from ? `${file.from} → ${file.path}` : file.path}
                  onClick={() => onOpenDiff(file)}
                >
                  <span className="git-code" data-status={statusClass(file)}>{statusCode(file)}</span>
                  <span className="git-file-path">{truncateStart(file.path, 30)}</span>
                </button>
                <span className="git-file-actions">
                  {onDiscard && (
                    <button
                      type="button"
                      className="icon-btn ghost-btn git-discard"
                      title="Descartar — não tem desfazer"
                      disabled={busy}
                      onClick={() => onDiscard(file)}
                    >
                      ↺
                    </button>
                  )}
                  <button
                    type="button"
                    className="icon-btn ghost-btn"
                    title={rowAction.title}
                    disabled={busy}
                    onClick={() => rowAction.run(file)}
                  >
                    {rowAction.label}
                  </button>
                </span>
              </div>

              {openDiff?.path === file.path && (
                <pre className="git-diff">
                  {openDiff.patch.trim() ? colorize(openDiff.patch) : 'sem diferenças de texto (binário ou modo)'}
                </pre>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/**
 * Letra que representa o arquivo na lista. O porcelain traz duas colunas; qual
 * das duas vale depende de onde o arquivo aparece — na seção de staged o que
 * importa é o índice, na de alterações é a árvore de trabalho.
 */
function statusCode(file: GitFileChange): string {
  if (file.isConflicted) return '!'
  if (file.isUntracked) return '?'
  return (file.isStaged ? file.index : file.worktree).trim() || file.index.trim() || 'M'
}

function statusClass(file: GitFileChange): string {
  const code = statusCode(file)
  if (code === '!') return 'conflict'
  if (code === '?') return 'new'
  if (code === 'A') return 'new'
  if (code === 'D') return 'del'
  if (code === 'R') return 'move'
  return 'mod'
}

/**
 * Colore o diff sem depender de biblioteca: uma linha por span, classificada
 * pelo primeiro caractere. É o suficiente para ler um patch curto no painel —
 * quem quiser mais tem o diff no terminal.
 */
function colorize(patch: string): JSX.Element[] {
  return patch.split('\n').map((line, i) => {
    let cls = 'git-diff-ctx'
    if (line.startsWith('+++') || line.startsWith('---')) cls = 'git-diff-head'
    else if (line.startsWith('@@')) cls = 'git-diff-hunk'
    else if (line.startsWith('+')) cls = 'git-diff-add'
    else if (line.startsWith('-')) cls = 'git-diff-del'
    return (
      <span key={i} className={cls}>
        {line}
        {'\n'}
      </span>
    )
  })
}
