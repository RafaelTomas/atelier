/**
 * Ambiente para processos filhos (PTY, git, agentes).
 *
 * No Windows a variável de caminho quase sempre chega como `Path`. O
 * `process.env` real resolve isso sem distinção de caixa, mas no instante em que
 * ele é espalhado num objeto simples (`{ ...process.env }`) a chave volta a ser
 * literal — e aí dois caminhos comuns quebram:
 *
 *   • `child_process` (execFile/spawn) só procura o binário em `env.PATH`
 *     (maiúsculo). Com a chave `Path`, um `git` instalado e no PATH do sistema
 *     dá `ENOENT`.
 *   • Escrever `env.PATH = …` à mão cria uma SEGUNDA chave. O filho herda as
 *     duas (`Path` cheia + `PATH` diferente) e o comportamento é indefinido —
 *     no PTY isso derrubava o PATH inteiro para só o que o Atelier prepende.
 *
 * `childEnv` normaliza para uma única chave `PATH`. `prependPath` mexe no PATH
 * mantendo essa garantia.
 */

export function childEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  const key = Object.keys(env).find((k) => k.toLowerCase() === 'path')
  if (key && key !== 'PATH') {
    env.PATH = env[key]
    delete env[key]
  }
  return { ...env, ...extra }
}

/** Antepõe um diretório ao PATH, preservando a chave única. */
export function prependPath(env: NodeJS.ProcessEnv, dir: string): void {
  const sep = process.platform === 'win32' ? ';' : ':'
  env.PATH = [dir, env.PATH ?? ''].filter(Boolean).join(sep)
}
