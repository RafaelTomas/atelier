/**
 * As ações que o painel dispara: stage, commit, pull, push, descartar.
 *
 * Cada uma devolve `{ ok }` ou `{ error }` com texto já legível — o painel não
 * interpreta código de saída do git, e o processo principal não deixa vazar
 * stderr cru com caminhos de fora do escopo.
 *
 * Nenhuma ação aqui reescreve história ou apaga trabalho sem que a UI tenha
 * perguntado antes: `discard` é a única destrutiva, e o painel confirma.
 */
import type { GitCommitEntry, GitLogResult } from '@shared/types'
import { firstLine, git } from './git'

export interface ActionResult {
  ok: boolean
  /** Mensagem para a UI: o que o git disse, resumido. */
  message: string
}

function done(run: { ok: boolean; stdout: string; stderr: string }, success: string): ActionResult {
  if (run.ok) {
    // O git manda quase tudo de útil por stderr (progresso do push inclusive);
    // preferimos a última linha dele ao texto genérico quando existe.
    const detail = firstLine(run.stdout) || firstLine(run.stderr)
    return { ok: true, message: detail || success }
  }
  return { ok: false, message: firstLine(run.stderr) || firstLine(run.stdout) || 'git falhou' }
}

/**
 * `--` antes dos caminhos, sempre.
 *
 * Um arquivo chamado `-f` ou `--hard` existe, e sem o separador o git o lê como
 * opção. É a diferença entre adicionar um arquivo e executar outra coisa.
 */
export async function stage(root: string, paths: string[]): Promise<ActionResult> {
  if (paths.length === 0) return { ok: false, message: 'nada selecionado' }
  return done(await git(root, ['add', '--', ...paths]), 'adicionado')
}

export async function stageAll(root: string): Promise<ActionResult> {
  return done(await git(root, ['add', '-A']), 'tudo adicionado')
}

/**
 * `restore --staged` e não `reset HEAD`: num repositório sem nenhum commit,
 * `reset HEAD` falha porque HEAD não existe, e é justamente no primeiro commit
 * que alguém mais tropeça em querer tirar um arquivo do stage.
 */
export async function unstage(root: string, paths: string[]): Promise<ActionResult> {
  if (paths.length === 0) return { ok: false, message: 'nada selecionado' }
  return done(await git(root, ['restore', '--staged', '--', ...paths]), 'removido do stage')
}

export async function unstageAll(root: string): Promise<ActionResult> {
  return done(await git(root, ['restore', '--staged', '--', '.']), 'stage limpo')
}

/**
 * Descartar: a única ação que perde trabalho.
 *
 * Não-rastreado e rastreado precisam de comandos diferentes — `restore` não
 * apaga arquivo que o git nunca viu — então quem chama informa quais são quais.
 * O `clean` vai com `-f` mas sem `-d` e sem `-x`: apaga os arquivos pedidos,
 * não varre diretórios inteiros nem toca no que o .gitignore protege (que é
 * onde moram `.env` e builds locais).
 */
export async function discard(
  root: string,
  tracked: string[],
  untracked: string[]
): Promise<ActionResult> {
  if (tracked.length === 0 && untracked.length === 0) return { ok: false, message: 'nada selecionado' }

  if (tracked.length > 0) {
    const res = await git(root, ['restore', '--worktree', '--staged', '--', ...tracked])
    if (!res.ok) return done(res, '')
  }
  if (untracked.length > 0) {
    const res = await git(root, ['clean', '-f', '--', ...untracked])
    if (!res.ok) return done(res, '')
  }
  return { ok: true, message: 'alterações descartadas' }
}

/**
 * Commit com a mensagem via stdin (`-F -`).
 *
 * Passar a mensagem como argumento estoura o limite do sistema em mensagens
 * longas e maltrata quebras de linha; por stdin o texto chega literal, com
 * corpo e rodapé intactos.
 */
export function commit(root: string, message: string, amend = false): Promise<ActionResult> {
  const text = message.trim()
  if (!text) return Promise.resolve({ ok: false, message: 'escreva uma mensagem' })

  const args = ['commit', '-F', '-']
  if (amend) args.push('--amend')

  return new Promise((resolve) => {
    void import('node:child_process').then(({ execFile }) => {
      const child = execFile(
        'git',
        args,
        { cwd: root, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' }, windowsHide: true },
        (err, stdout, stderr) => {
          if (err) {
            resolve({ ok: false, message: firstLine(String(stderr)) || firstLine(String(stdout)) || 'commit falhou' })
            return
          }
          resolve({ ok: true, message: firstLine(String(stdout)) || 'commit feito' })
        }
      )
      child.stdin?.end(text)
    })
  })
}

/**
 * `pull --ff-only`: sem merge automático.
 *
 * Um pull que abre merge no meio de trabalho não commitado é como a maioria das
 * árvores quebradas começa. Falhando o fast-forward, a UI diz que divergiu e a
 * pessoa decide o que fazer — de preferência num terminal, com o histórico à
 * vista.
 */
export async function pull(root: string): Promise<ActionResult> {
  const res = await git(root, ['pull', '--ff-only'], true)
  if (!res.ok) {
    const err = firstLine(res.stderr)
    if (/not possible to fast-forward|diverged/i.test(res.stderr)) {
      return { ok: false, message: 'o branch divergiu do remoto — resolva num terminal (rebase ou merge)' }
    }
    return { ok: false, message: err || 'pull falhou' }
  }
  return { ok: true, message: firstLine(res.stdout) || 'atualizado' }
}

export async function fetch(root: string): Promise<ActionResult> {
  return done(await git(root, ['fetch', '--prune'], true), 'remoto consultado')
}

/**
 * Push. Sem upstream, publica o branch (`-u origin <branch>`) — é o que a
 * pessoa quer quando aperta push num branch novo.
 *
 * Nunca `--force`. Se o push for recusado por estar atrás, a mensagem manda
 * puxar antes; forçar daqui apagaria commit de outra pessoa com um clique.
 */
export async function push(root: string, branch: string | null, hasUpstream: boolean): Promise<ActionResult> {
  const args = hasUpstream ? ['push'] : branch ? ['push', '-u', 'origin', branch] : ['push']
  const res = await git(root, args, true)
  if (!res.ok) {
    if (/rejected|non-fast-forward|fetch first/i.test(res.stderr)) {
      return { ok: false, message: 'o remoto tem commits que você não tem — puxe antes de publicar' }
    }
    return { ok: false, message: firstLine(res.stderr) || 'push falhou' }
  }
  // O push fala por stderr; a linha útil ("main -> main") está lá.
  return { ok: true, message: firstLine(res.stderr) || firstLine(res.stdout) || 'publicado' }
}

/**
 * Últimos commits, para a aba de histórico.
 *
 * Separador NUL entre campos e entre registros pelo mesmo motivo do status:
 * assunto de commit contém tabulação, pipe e tudo mais que se usaria como
 * delimitador improvisado.
 */
export async function log(root: string, limit = 30): Promise<GitLogResult | { error: string }> {
  const res = await git(root, [
    'log',
    `--max-count=${Math.max(1, Math.min(200, limit))}`,
    '--format=%h%x00%an%x00%ar%x00%s%x00'
  ])
  if (!res.ok) {
    // Repositório sem nenhum commit não é erro: é um repositório novo.
    if (/does not have any commits|bad revision/i.test(res.stderr)) return { commits: [] }
    return { error: firstLine(res.stderr) || 'log falhou' }
  }

  const fields = res.stdout.split('\0')
  const commits: GitCommitEntry[] = []
  // Quatro campos por commit; o último traz o \n que separa os registros.
  for (let i = 0; i + 3 < fields.length; i += 4) {
    const hash = fields[i].replace(/^\n/, '').trim()
    if (!hash) continue
    commits.push({ hash, author: fields[i + 1], relativeDate: fields[i + 2], subject: fields[i + 3] })
  }
  return { commits }
}

/**
 * Diff de um arquivo. Staged e não-staged são diffs diferentes do mesmo
 * caminho, então quem chama diz qual quer.
 */
export async function diff(root: string, path: string, staged: boolean): Promise<{ patch: string } | { error: string }> {
  const args = staged ? ['diff', '--cached', '--', path] : ['diff', '--', path]
  const res = await git(root, args)
  if (!res.ok) return { error: firstLine(res.stderr) || 'diff falhou' }
  return { patch: res.stdout }
}

/** Branches locais, com o atual marcado. Alimenta o seletor do cabeçalho. */
export async function branches(root: string): Promise<{ names: string[]; current: string | null } | { error: string }> {
  const res = await git(root, ['branch', '--format=%(refname:short)%00%(HEAD)'])
  if (!res.ok) return { error: firstLine(res.stderr) || 'branch falhou' }

  const names: string[] = []
  let current: string | null = null
  for (const line of res.stdout.split('\n')) {
    if (!line.trim()) continue
    const [name, head] = line.split('\0')
    if (!name) continue
    names.push(name)
    if (head?.trim() === '*') current = name
  }
  return { names, current }
}

/**
 * Trocar de branch. `switch` e não `checkout`: recusa-se a trocar quando há
 * trabalho que seria sobrescrito, em vez de carregar as mudanças junto sem
 * avisar.
 */
export async function switchBranch(root: string, name: string): Promise<ActionResult> {
  const res = await git(root, ['switch', '--', name])
  if (!res.ok) {
    if (/local changes|would be overwritten/i.test(res.stderr)) {
      return { ok: false, message: 'há alterações que seriam sobrescritas — commite ou descarte antes' }
    }
    return { ok: false, message: firstLine(res.stderr) || 'não foi possível trocar de branch' }
  }
  return { ok: true, message: `agora em ${name}` }
}

/** Cria e já entra no branch novo, a partir do HEAD atual. */
export async function createBranch(root: string, name: string): Promise<ActionResult> {
  const clean = name.trim()
  if (!clean) return { ok: false, message: 'dê um nome ao branch' }
  const res = await git(root, ['switch', '-c', clean])
  if (!res.ok) return { ok: false, message: firstLine(res.stderr) || 'não foi possível criar o branch' }
  return { ok: true, message: `branch ${clean} criado` }
}
