/**
 * Git no processo principal.
 *
 * `execFile` e nunca `exec`: sem shell, nenhum caminho de projeto com espaço,
 * aspas ou `$(...)` no nome vira comando. Todo argumento vai como elemento do
 * array, e nada aqui monta linha de comando por concatenação.
 *
 * O renderer não escolhe o que rodar: os subcomandos são os deste arquivo, e o
 * `cwd` passa pela mesma portaria da árvore de arquivos (resolveAllowedPath).
 * O que o renderer manda é um repositório e, em algumas ações, nomes de
 * arquivo — que vão sempre depois de `--`, para que um arquivo chamado
 * `--force` seja tratado como arquivo.
 */
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import type { GitFileChange, GitStatus } from '@shared/types'
import { log } from '../logger'
import { childEnv } from '../subprocess-env'

/**
 * Teto de saída. `git log` num repositório grande, ou um push que resolve mal
 * o remoto, pode despejar megabytes — e tudo isso atravessaria o IPC clonado.
 */
const MAX_BUFFER = 4 * 1024 * 1024

/**
 * Rede tem outro tempo que disco. Sem isto, um `push` para um host inacessível
 * deixa o botão girando para sempre, porque nada nunca volta.
 */
const TIMEOUT_LOCAL = 15_000
const TIMEOUT_NETWORK = 120_000

export interface GitRun {
  ok: boolean
  stdout: string
  stderr: string
  /** null quando o processo morreu por sinal ou nem chegou a existir. */
  code: number | null
}

/**
 * Ambiente de um git não-interativo.
 *
 * Sem isto, um `pull` que precise de senha bloqueia o processo principal para
 * sempre esperando um terminal que não existe — a janela inteira congela junto.
 * Com `GIT_TERMINAL_PROMPT=0` o git falha rápido e a mensagem chega à UI, que é
 * o comportamento que dá para explicar ao usuário.
 */
function gitEnv(): NodeJS.ProcessEnv {
  // `childEnv` normaliza a chave do PATH: sem isso, no Windows o `execFile`
  // procura o binário só em `env.PATH` e um `git` instalado dá `ENOENT`.
  return childEnv({
    GIT_TERMINAL_PROMPT: '0',
    // O askpass gráfico (macOS Keychain, libsecret) continua valendo; o que se
    // corta é só o prompt de TTY. Quem tem credencial em agente segue passando.
    GIT_OPTIONAL_LOCKS: '0',
    LC_ALL: 'C'
  })
}

/** Executa `git` no diretório dado. Nunca lança: falha vira `ok: false`. */
export function git(cwd: string, args: string[], network = false): Promise<GitRun> {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      {
        cwd,
        env: gitEnv(),
        maxBuffer: MAX_BUFFER,
        timeout: network ? TIMEOUT_NETWORK : TIMEOUT_LOCAL,
        windowsHide: true
      },
      (err, stdout, stderr) => {
        const e = err as (Error & { code?: number | string; killed?: boolean }) | null
        if (e) {
          log.debug('git', `${args[0]} falhou em ${cwd}`, e.message)
          // `killed` com timeout: a mensagem do execFile não diz isso, e "não
          // respondeu" é a única explicação útil para quem está olhando.
          const timedOut = e.killed === true
          resolve({
            ok: false,
            stdout: String(stdout ?? ''),
            stderr: timedOut
              ? `git ${args[0]} não respondeu a tempo`
              : String(stderr ?? '') || e.message,
            code: typeof e.code === 'number' ? e.code : null
          })
          return
        }
        resolve({ ok: true, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), code: 0 })
      }
    )
  })
}

/** Primeira linha não vazia — o que cabe numa mensagem de erro na UI. */
export function firstLine(text: string): string {
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (t) return t
  }
  return ''
}

/**
 * O repositório que contém `cwd`, ou null.
 *
 * Devolve a raiz e não um booleano porque abrir a pasta de um subdiretório é
 * comum (a aba Arquivos navega para dentro), e todas as ações seguintes têm de
 * valer para o repositório inteiro, não para a subpasta.
 */
export async function repoRoot(cwd: string): Promise<string | null> {
  const res = await git(cwd, ['rev-parse', '--show-toplevel'])
  if (!res.ok) return null
  const root = res.stdout.trim()
  return root.length > 0 ? root : null
}

/**
 * `git status --porcelain=v1 -z`: registros separados por NUL.
 *
 * O `-z` não é preciosismo. Sem ele, um arquivo com espaço vem entre aspas e
 * com escapes, e um arquivo com `\n` no nome quebra o parser por linha em dois
 * registros inventados. Com NUL, o nome é literal e o limite é inequívoco.
 *
 * Formato: `XY<espaço>caminho`, e quando X é R ou C vem um registro extra logo
 * depois com o caminho de origem.
 */
export function parsePorcelain(raw: string): GitFileChange[] {
  const out: GitFileChange[] = []
  const records = raw.split('\0')

  for (let i = 0; i < records.length; i++) {
    const record = records[i]
    if (record.length < 4) continue

    const index = record[0]
    const worktree = record[1]
    const path = record.slice(3)

    // Rename/copy consomem o registro seguinte, que é a origem.
    let from: string | null = null
    if (index === 'R' || index === 'C') {
      from = records[i + 1] ?? null
      i++
    }

    out.push({
      path,
      from,
      index,
      worktree,
      // `??` é o não-rastreado; nele os dois campos são `?`, e nada está staged.
      isStaged: index !== ' ' && index !== '?',
      isUntracked: index === '?' && worktree === '?',
      // Conflito: qualquer lado com U, ou os pares AA/DD.
      isConflicted:
        index === 'U' || worktree === 'U' || (index === 'A' && worktree === 'A') || (index === 'D' && worktree === 'D')
    })
  }

  // Ordem estável: conflitos primeiro (é o que trava tudo), depois staged,
  // depois o resto em ordem de caminho. Sem isto a lista dança a cada refresh.
  return out.sort((a, b) => {
    if (a.isConflicted !== b.isConflicted) return a.isConflicted ? -1 : 1
    if (a.isStaged !== b.isStaged) return a.isStaged ? -1 : 1
    return a.path.localeCompare(b.path)
  })
}

/**
 * Branch atual, ou null quando o HEAD está solto (detached).
 *
 * `symbolic-ref` e não `rev-parse --abbrev-ref HEAD`: antes do primeiro commit
 * o HEAD aponta para um branch que ainda não tem objeto, e o rev-parse falha
 * com "ambiguous argument". O painel mostraria "HEAD solto" justamente num
 * repositório recém-criado, que é quando a pessoa mais precisa ver o nome.
 * O symbolic-ref lê a referência, não o commit, e responde certo nos dois casos.
 */
async function currentBranch(root: string): Promise<string | null> {
  const res = await git(root, ['symbolic-ref', '--short', 'HEAD'])
  if (res.ok) {
    const name = res.stdout.trim()
    if (name) return name
  }
  // Falhou de verdade: HEAD solto (detached), num commit sem branch.
  return null
}

/**
 * Quantos commits à frente e atrás do upstream.
 *
 * Sem upstream configurado o comando falha — e isso não é erro: é um branch
 * novo que nunca foi publicado. Nesse caso o painel mostra "publicar branch"
 * em vez de setas.
 */
async function divergence(root: string): Promise<{ ahead: number; behind: number; upstream: string | null }> {
  const up = await git(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'])
  if (!up.ok) return { ahead: 0, behind: 0, upstream: null }
  const upstream = up.stdout.trim() || null

  const counts = await git(root, ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'])
  if (!counts.ok) return { ahead: 0, behind: 0, upstream }

  const [ahead, behind] = counts.stdout.trim().split(/\s+/).map((n) => Number.parseInt(n, 10) || 0)
  return { ahead: ahead ?? 0, behind: behind ?? 0, upstream }
}

/**
 * Estado no meio de um merge/rebase/cherry-pick.
 *
 * Importa porque muda o que os botões podem fazer: commitar no meio de um
 * rebase não é "commitar", é continuar o rebase, e oferecer o botão normal ali
 * é como se pede para alguém perder trabalho.
 */
async function pendingOperation(root: string): Promise<GitStatus['operation']> {
  const gitDir = await git(root, ['rev-parse', '--git-dir'])
  if (!gitDir.ok) return null
  const dir = gitDir.stdout.trim()
  const abs = dir.startsWith('/') ? dir : join(root, dir)

  const { access } = await import('node:fs/promises')
  const exists = async (p: string): Promise<boolean> => {
    try {
      await access(join(abs, p))
      return true
    } catch {
      return false
    }
  }

  if (await exists('rebase-merge')) return 'rebase'
  if (await exists('rebase-apply')) return 'rebase'
  if (await exists('MERGE_HEAD')) return 'merge'
  if (await exists('CHERRY_PICK_HEAD')) return 'cherry-pick'
  if (await exists('REVERT_HEAD')) return 'revert'
  return null
}

/** Retrato completo do repositório — o que o painel desenha a cada refresh. */
/**
 * O que a árvore de arquivos precisa saber do git, numa consulta só:
 *
 *   • `unversioned` — não rastreado (`??`) e ignorado (`!!`). Juntos, são
 *     exatamente o que não está no repositório;
 *   • `changed` — rastreado e com mudança, no índice ou na árvore de trabalho.
 *
 * Consulta separada do `status()` do painel, de propósito: aqui `--ignored` é
 * metade da resposta, e ligá-lo lá faria o painel de Git listar node_modules
 * inteiro como mudança pendente.
 *
 * `--untracked-files=normal` e não `=all`: é o que faz o git COLAPSAR diretório
 * inteiro em um registro só — `node_modules/`, `snapshots/`. Medido num projeto
 * real: 44 registros contra 13.426 com `=all`, porque ali o git lista arquivo
 * por arquivo mesmo dentro do que ignora. Quem consome trata o diretório como
 * cobertura dos filhos.
 */
export interface TreeGitStatus {
  /** Raiz do REPOSITÓRIO — pode ser ancestral da pasta consultada. */
  root: string
  /** Relativos à raiz, sem barra no fim. */
  unversioned: string[]
  changed: string[]
}

export async function treeStatus(cwd: string): Promise<TreeGitStatus | { error: string }> {
  const root = await repoRoot(cwd)
  if (!root) return { error: 'not-a-repo' }

  const st = await git(root, [
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=normal',
    '--ignored'
  ])
  if (!st.ok) return { error: firstLine(st.stderr) || 'status falhou' }

  const unversioned: string[] = []
  const changed: string[] = []
  const records = st.stdout.split('\0')
  for (let i = 0; i < records.length; i++) {
    const record = records[i]
    if (record.length < 4) continue
    const code = record.slice(0, 2)
    const path = record.slice(3).replace(/\/$/, '')
    // Rename/copy consomem o registro seguinte (a origem); sem pular, ele seria
    // lido como se fosse um caminho com código próprio.
    if (code[0] === 'R' || code[0] === 'C') i++

    if (code === '??' || code === '!!') unversioned.push(path)
    else changed.push(path)
  }
  return { root, unversioned, changed }
}

export async function status(cwd: string): Promise<GitStatus | { error: string }> {
  const root = await repoRoot(cwd)
  if (!root) return { error: 'not-a-repo' }

  const st = await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
  if (!st.ok) return { error: firstLine(st.stderr) || 'status falhou' }

  const [branch, div, operation, remote] = await Promise.all([
    currentBranch(root),
    divergence(root),
    pendingOperation(root),
    git(root, ['remote', 'get-url', 'origin']).then((r) => (r.ok ? r.stdout.trim() || null : null))
  ])

  return {
    root,
    branch,
    upstream: div.upstream,
    ahead: div.ahead,
    behind: div.behind,
    remote,
    operation,
    files: parsePorcelain(st.stdout)
  }
}
