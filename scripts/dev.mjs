/**
 * `npm run dev` multiplataforma.
 *
 * O script antigo era `ATELIER_HOME=$HOME/.atelier-dev electron-vite dev` — a
 * atribuição inline de variável só existe em shell POSIX, então no PowerShell e
 * no cmd do Windows ele quebrava antes de começar. Este wrapper faz as três
 * coisas que aquele fazia, em JS:
 *
 *   1. Aponta ATELIER_HOME para ~/.atelier-dev, para o desenvolvimento não
 *      encostar nos dados reais (respeita um ATELIER_HOME já definido).
 *   2. Remove ELECTRON_RUN_AS_NODE — o terminal integrado do VS Code exporta
 *      essa variável, e com ela o Electron sobe em modo Node e morre em
 *      `requestSingleInstanceLock` (ver README, Solução de problemas).
 *   3. Chama o `electron-vite dev`, repassando qualquer argumento extra.
 */
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const env = { ...process.env }
if (!env.ATELIER_HOME) env.ATELIER_HOME = join(homedir(), '.atelier-dev')
delete env.ELECTRON_RUN_AS_NODE

const bin = join(root, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js')
const child = spawn(process.execPath, [bin, 'dev', ...process.argv.slice(2)], {
  cwd: root,
  env,
  stdio: 'inherit'
})

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  else process.exit(code ?? 0)
})
