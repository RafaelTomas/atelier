/**
 * Reconhece um projeto e lê os metadados baratos que dão conteúdo ao painel
 * sem agente nenhum.
 *
 * A regra é uma só: um diretório é projeto se contém `.git`. O repositório é a
 * unidade — que é como o usuário já pensa nos próprios projetos. Uma tabela de
 * manifestos (package.json, go.mod, pom.xml…) parece mais generosa, mas quebra
 * um repositório com `backend/` e `frontend/` em duas entradas, nenhuma delas o
 * projeto, e depois obriga a inventar nomes para desempatar o que ela mesma
 * duplicou.
 *
 * A divisão em duas etapas é deliberada: `isRepository` e `inferKind` recebem as
 * entradas que o walk JÁ leu (nenhuma syscall extra) e rodam em todo diretório
 * visitado; `readProjectMeta` abre arquivos e roda só nos que qualificaram —
 * dezenas, não dezenas de milhares.
 *
 * Nada aqui spawna `git`: 56 projetos × ~30ms por spawn são ~2s, e `git` no
 * PATH é uma suposição que o Windows não honra. `.git/HEAD` e `.git/config` são
 * texto simples e respondem branch e remote com duas leituras pequenas.
 */
import type { Dirent } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { DiscoveredProject } from '@shared/types'
import { toISO8601 } from '../coding'

/** A regra inteira. `.git` pode ser diretório ou arquivo (worktree, submódulo). */
export function isRepository(entries: Dirent[]): boolean {
  return entries.some((e) => e.name === '.git')
}

/**
 * Arquivo de raiz → (kind, linguagem). Isto é SÓ o selo do painel: errar aqui
 * custa um rótulo, nunca uma entrada a mais ou a menos no índice. É o que
 * permite a lista ser curta e imperfeita sem consequência — quando ela decidia
 * o que era projeto, cada ausência virava um projeto invisível.
 */
const KIND_HINTS: Array<[string, string, string | null]> = [
  ['package.json', 'node', 'javascript'],
  ['deno.json', 'deno', 'typescript'],
  ['go.mod', 'go', 'go'],
  ['Cargo.toml', 'rust', 'rust'],
  ['pyproject.toml', 'python', 'python'],
  ['requirements.txt', 'python', 'python'],
  ['pom.xml', 'maven', 'java'],
  ['build.gradle', 'gradle', 'java'],
  ['build.gradle.kts', 'gradle', 'kotlin'],
  ['composer.json', 'php', 'php'],
  ['Gemfile', 'ruby', 'ruby'],
  ['pubspec.yaml', 'flutter', 'dart'],
  ['CMakeLists.txt', 'cmake', 'cpp'],
  ['Package.swift', 'swift', 'swift'],
  ['mix.exs', 'elixir', 'elixir']
]

/** Projetos .NET e Xcode não têm nome de arquivo fixo, só extensão. */
const SUFFIX_HINTS: Array<[string, string, string]> = [
  ['.sln', 'dotnet', 'csharp'],
  ['.csproj', 'dotnet', 'csharp'],
  ['.xcodeproj', 'xcode', 'swift']
]

export function inferKind(entries: Dirent[]): { kind: string; language: string | null } {
  const names = new Set(entries.map((e) => e.name))

  for (const [file, kind, language] of KIND_HINTS) {
    if (names.has(file)) return { kind, language }
  }
  for (const name of names) {
    const hit = SUFFIX_HINTS.find(([suffix]) => name.endsWith(suffix))
    if (hit) return { kind: hit[1], language: hit[2] }
  }

  // Sem manifesto reconhecido: 'git' para um repositório de docs ou configs,
  // 'folder' para a pasta que o usuário adicionou à mão — o único caso em que
  // um projeto chega aqui sem repositório.
  return { kind: names.has('.git') ? 'git' : 'folder', language: null }
}

/**
 * Lê os metadados baratos do projeto. Toda leitura é limitada e todo erro é
 * engolido: um manifest quebrado não pode derrubar a varredura inteira.
 *
 * Recebe as entradas já lidas pelo walk para decidir o que vale abrir, em vez
 * de tentar e tratar ENOENT em cima de cada arquivo possível.
 */
export async function readProjectMeta(
  path: string,
  entries: Dirent[]
): Promise<Omit<DiscoveredProject, 'kind' | 'language'>> {
  const names = new Set(entries.map((e) => e.name))
  const result = {
    path,
    // O nome é o da pasta, sempre. O `name` do manifesto é o que enchia o
    // painel de "backend": ele nomeia o pacote, não o projeto no disco.
    name: basename(path),
    summary: null as string | null,
    stack: [] as string[],
    gitBranch: null as string | null,
    gitRemote: null as string | null,
    lastCommitAt: null as string | null
  }

  if (names.has('package.json')) {
    const pkg = await readJSONSafe(join(path, 'package.json'))
    if (pkg) {
      if (typeof pkg.description === 'string' && pkg.description.trim()) {
        result.summary = pkg.description.trim().slice(0, 300)
      }
      result.stack = inferStack(pkg)
    }
  }

  if (!result.summary) result.summary = await readReadmeHeadline(path)

  if (names.has('.git')) {
    const git = await readGitInfo(path)
    result.gitBranch = git.branch
    result.gitRemote = git.remote
    result.lastCommitAt = git.lastCommitAt
  }

  return result
}

async function readJSONSafe(file: string): Promise<Record<string, unknown> | null> {
  try {
    const text = await readFile(file, 'utf8')
    const parsed: unknown = JSON.parse(text)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** Dependências conhecidas → nome de stack legível, para o badge do painel. */
const STACK_HINTS: Array<[string, string]> = [
  ['next', 'Next.js'],
  ['react', 'React'],
  ['vue', 'Vue'],
  ['svelte', 'Svelte'],
  ['@angular/core', 'Angular'],
  ['electron', 'Electron'],
  ['@nestjs/core', 'NestJS'],
  ['express', 'Express'],
  ['fastify', 'Fastify'],
  ['typescript', 'TypeScript'],
  ['vite', 'Vite'],
  ['tailwindcss', 'Tailwind']
]

function inferStack(pkg: Record<string, unknown>): string[] {
  const deps = {
    ...(pkg.dependencies as Record<string, unknown> | undefined),
    ...(pkg.devDependencies as Record<string, unknown> | undefined)
  }
  const found = STACK_HINTS.filter(([dep]) => dep in deps).map(([, label]) => label)
  return found.slice(0, 6)
}

/**
 * Primeira linha significativa do README. Lê só os primeiros 4 KB: READMEs de
 * centenas de KB existem e não têm nada de útil depois do título.
 */
async function readReadmeHeadline(path: string): Promise<string | null> {
  for (const file of ['README.md', 'README.rst', 'README.txt', 'README']) {
    let text: string
    try {
      const handle = await readFile(join(path, file), { encoding: 'utf8', flag: 'r' })
      text = handle.slice(0, 4096)
    } catch {
      continue
    }
    for (const raw of text.split('\n')) {
      const line = raw.replace(/^#+\s*/, '').replace(/[*_`]/g, '').trim()
      // Pula badges, HTML de centralização e linhas decorativas
      if (!line || line.startsWith('<') || line.startsWith('[!') || /^[-=]+$/.test(line)) continue
      return line.slice(0, 300)
    }
  }
  return null
}

/** Branch, remote e data do último commit — sem spawnar `git`. */
export async function readGitInfo(
  path: string
): Promise<{ branch: string | null; remote: string | null; lastCommitAt: string | null }> {
  const gitDir = join(path, '.git')
  let branch: string | null = null
  let remote: string | null = null
  let lastCommitAt: string | null = null

  try {
    const head = await readFile(join(gitDir, 'HEAD'), 'utf8')
    const match = head.match(/^ref:\s*refs\/heads\/(.+)$/m)
    branch = match ? match[1].trim() : null
  } catch {
    // .git pode ser um arquivo (worktree/submódulo) ou estar ilegível
  }

  try {
    const config = await readFile(join(gitDir, 'config'), 'utf8')
    const section = config.match(/\[remote "origin"\]([\s\S]*?)(?=\n\[|$)/)
    const url = section?.[1].match(/^\s*url\s*=\s*(.+)$/m)
    remote = url ? url[1].trim() : null
  } catch {
    // sem remote configurado
  }

  // mtime da ref é um sinal de "último trabalho" muito melhor que o do diretório,
  // que qualquer build ou editor atualiza.
  const refFile = branch ? join(gitDir, 'refs', 'heads', branch) : join(gitDir, 'HEAD')
  try {
    const info = await stat(refFile)
    lastCommitAt = toISO8601(info.mtime)
  } catch {
    // ref empacotada (packed-refs) ou repo recém-criado
  }

  return { branch, remote, lastCommitAt }
}
