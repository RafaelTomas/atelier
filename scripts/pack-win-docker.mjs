/**
 * Empacota o Windows a partir de Linux/macOS, dentro do container oficial do
 * electron-builder.
 *
 * Por que existe: gravar ícone, nome e metadados dentro do Atelier.exe exige
 * wine (é o `signAndEditExecutable: true` do electron-builder.yml). Sem wine no
 * host, `npm run pack:win` morre em WinPackager.signApp com
 * ERR_ELECTRON_BUILDER_CANNOT_EXECUTE. A imagem electronuserland/builder:wine
 * já traz wine + nsis; o container só roda o electron-builder sobre o out/ que
 * o build local acabou de gerar.
 *
 * O container roda com o uid/gid do host para que dist/ não saia dono do root.
 * HOME é um segundo bind mount, e mora FORA do repositório de propósito: o wine
 * cria em dosdevices/ um `z:` que aponta para `/`. Dentro do projeto, esse link
 * fecha um ciclo que qualquer varredura que siga symlink (a do VS Code segue, e
 * com --no-ignore o .gitignore não a segura) percorre para sempre — o processo
 * que consome a listagem cresceu 3 MB/s até 3,9 GB antes de alguém notar. Em
 * ~/.cache/atelier/docker-home o mesmo link existe, mas ninguém varre lá.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const HOME = join(homedir(), '.cache', 'atelier', 'docker-home')
const IMAGE = 'electronuserland/builder:wine'

mkdirSync(HOME, { recursive: true })

const uid = typeof process.getuid === 'function' ? process.getuid() : 0
const gid = typeof process.getgid === 'function' ? process.getgid() : 0

const args = [
  'run', '--rm',
  '--user', `${uid}:${gid}`,
  '-e', 'HOME=/docker-home',
  '-e', 'ELECTRON_CACHE=/docker-home/.cache/electron',
  '-e', 'ELECTRON_BUILDER_CACHE=/docker-home/.cache/electron-builder',
  '-v', `${ROOT}:/project`,
  '-v', `${HOME}:/docker-home`,
  '-w', '/project',
  IMAGE,
  'npx', 'electron-builder', '--win'
]

execFileSync('docker', args, { stdio: 'inherit' })
