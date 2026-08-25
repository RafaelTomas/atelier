/**
 * Regras de poda da varredura.
 *
 * A poda é a única otimização que importa aqui. Medido na home real de um
 * desenvolvedor: um walk até 6 níveis SEM poda lê 74.030 diretórios e 579.521
 * entradas (~1s com cache quente, dezenas de segundos frio); COM poda e parada
 * no primeiro marcador, lê 452 diretórios e acha os mesmos 56 projetos em 12ms.
 *
 * Trocar o mecanismo de concorrência muda isso por um fator de ~2. Podar muda
 * por um fator de ~100. Por isso a lista abaixo é a parte séria do scanner.
 */

/**
 * Diretórios que nunca contêm projetos do usuário — só dependências, caches,
 * artefatos de build e pastas de sistema.
 *
 * Diretórios ocultos NÃO precisam entrar aqui: o scanner pula todos por regra
 * (o que mata .cache, .config, .local, .npm, .vscode de uma vez). As entradas
 * ocultas listadas aqui existem só para documentar a intenção em pastas que
 * alguém poderia querer destravar depois.
 */
export const DEFAULT_EXCLUDED_DIRS: ReadonlySet<string> = new Set([
  // Dependências
  'node_modules',
  'bower_components',
  'vendor',
  'Pods',
  'packages',
  // Ambientes virtuais / toolchains
  '.venv',
  'venv',
  'env',
  '__pycache__',
  '.tox',
  '.gradle',
  '.m2',
  '.cargo',
  '.rustup',
  '.nvm',
  '.pyenv',
  // Artefatos de build
  'dist',
  'build',
  'out',
  'target',
  'bin',
  'obj',
  '.next',
  '.nuxt',
  '.turbo',
  '.svelte-kit',
  '.output',
  'DerivedData',
  'coverage',
  // Lixo de descompactação: o __MACOSX de um .zip carrega uma cópia inteira da
  // árvore, com .git e tudo, e cada projeto lá dentro entrava no índice de novo.
  '__MACOSX',
  // Sistema / usuário, sem projeto dentro
  'Library',
  'Applications',
  'Downloads',
  'Movies',
  'Music',
  'Pictures',
  'Trash',
  'snap',
  'AppData',
  'OneDrive',
  'Program Files',
  'Program Files (x86)',
  'Windows'
])

/**
 * Um diretório oculto é pulado, com uma exceção: `.git` nunca é DESCIDO, mas é
 * lido pelo nome na listagem do pai para detectar o repositório. Esta função
 * responde só sobre descer.
 */
export function shouldSkipDir(name: string, excluded: ReadonlySet<string>): boolean {
  if (name.startsWith('.')) return true
  return excluded.has(name)
}
