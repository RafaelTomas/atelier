/**
 * Instala o CLI `atelier` num diretório que entra no PATH dos terminais.
 *
 * No app nativo o CLI é um binário dentro do .app. Aqui ele é um script Node
 * executado pelo runtime do próprio Electron (ELECTRON_RUN_AS_NODE=1), o que
 * evita exigir Node instalado na máquina do usuário. Wrappers: `atelier` (sh)
 * e `atelier.cmd` (Windows).
 *
 * No Windows os DOIS são escritos, e não só o `.cmd`. Quem chama o CLI nem
 * sempre é o shell do PTY: o Claude Code executa a `statusLine` e os hooks por
 * um shell POSIX (o Git Bash da máquina), e o `sh` não conhece `PATHEXT` — um
 * `atelier statusline` ali resolvia para nada, em silêncio, e o monitor ficava
 * sem nenhuma leitura de consumo da conta. O `.cmd` continua sendo o
 * `ATELIER_CLI`, porque é ele que o `cmd.exe` e o PowerShell sabem chamar.
 */
import { chmod, copyFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { log } from '../logger'
import { dataDir } from '../persistence/paths'

export function atelierBinDir(): { dir: string; cliPath: string } {
  const dir = join(dataDir(), 'bin')
  const cliPath = join(dir, process.platform === 'win32' ? 'atelier.cmd' : 'atelier')
  return { dir, cliPath }
}

/**
 * O CLI por CAMINHO ABSOLUTO, para quem não pode contar com o PATH.
 *
 * O `PATH` do PTY recebe `<dados>/bin` na frente (terminal-manager), mas o
 * shell interativo carrega o profile do usuário DEPOIS, e um `.bashrc` que faz
 * `export PATH=/usr/bin:/bin:...` — reatribuição, e não prefixo — apaga o
 * diretório do Atelier sem avisar. Aí `atelier statusline` resolve para outro
 * `atelier` qualquer no sistema (no Linux, o launcher do próprio app instalado
 * pelo pacote), que sobe uma segunda instância, morre com "outra instância já
 * está rodando" e sai com código 0: a `statusLine` falha em SILÊNCIO e o
 * monitor fica sem nenhuma leitura da conta. O mesmo vale para os hooks do
 * Artesão.
 *
 * Por isso o comando gravado no settings é o caminho inteiro. É o wrapper `sh`
 * — e não o `ATELIER_CLI` — porque quem executa `statusLine` e hooks é um shell
 * POSIX em toda plataforma (no Windows, o Git Bash), e o `sh` não sabe rodar um
 * `.cmd`. Barras normalizadas para `/` pelo mesmo motivo: `C:\Users\...` dentro
 * de aspas duplas passaria pelo tratamento de escape do `sh`.
 */
export function cliCommand(args: string): string {
  const { dir } = atelierBinDir()
  return `"${join(dir, 'atelier').replace(/\\/g, '/')}" ${args}`
}

/**
 * Caminho do atelier.cjs empacotado (dev e produção diferem).
 *
 * O import do electron é dinâmico de propósito: mantém este módulo — e toda a
 * cadeia terminal → IPC → handlers — importável fora do Electron, o que é o que
 * permite rodar o núcleo headless em teste e em CI.
 */
async function bundledCliSource(): Promise<string> {
  const { app } = await import('electron')
  return app.isPackaged
    ? join(process.resourcesPath, 'atelier.cjs')
    : join(app.getAppPath(), 'resources', 'atelier.cjs')
}

/**
 * Idempotente, roda a cada boot — mesma política do SkillInjector do app nativo.
 */
export async function installCLI(): Promise<void> {
  const { dir } = atelierBinDir()
  await mkdir(dir, { recursive: true })

  const target = join(dir, 'atelier.cjs')
  try {
    await copyFile(await bundledCliSource(), target)
  } catch (err) {
    log.error('cli-install', 'não foi possível copiar atelier.cjs', err)
    return
  }

  const electronBin = process.execPath

  if (process.platform === 'win32') {
    const cmd = [
      '@echo off',
      'setlocal',
      'set ELECTRON_RUN_AS_NODE=1',
      `"${electronBin}" "${target}" %*`,
      'endlocal'
    ].join('\r\n')
    await writeFile(join(dir, 'atelier.cmd'), cmd, 'utf8')
  }

  // O wrapper `sh` sai em TODA plataforma — ver o cabeçalho. Fim de linha `\n`
  // mesmo no Windows: um `\r` depois do shebang faz o sh procurar um
  // interpretador chamado `/bin/sh\r`, e o comando morre sem dizer por quê.
  const sh = [
    '#!/bin/sh',
    '# gerado pelo Atelier — não editar',
    `ELECTRON_RUN_AS_NODE=1 exec "${electronBin}" "${target}" "$@"`,
    ''
  ].join('\n')
  const wrapper = join(dir, 'atelier')
  await writeFile(wrapper, sh, 'utf8')
  // No Windows o `chmod` é inócuo, e o Git Bash executa pelo shebang mesmo.
  await chmod(wrapper, 0o755)

  log.info('cli-install', `atelier instalado em ${dir}`)
}
