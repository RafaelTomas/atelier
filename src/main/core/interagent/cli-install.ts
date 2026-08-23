/**
 * Instala o CLI `atelier` num diretório que entra no PATH dos terminais.
 *
 * No app nativo o CLI é um binário dentro do .app. Aqui ele é um script Node
 * executado pelo runtime do próprio Electron (ELECTRON_RUN_AS_NODE=1), o que
 * evita exigir Node instalado na máquina do usuário. Wrappers: `atelier` (sh)
 * e `atelier.cmd` (Windows).
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
  } else {
    const sh = [
      '#!/bin/sh',
      '# gerado pelo Atelier — não editar',
      `ELECTRON_RUN_AS_NODE=1 exec "${electronBin}" "${target}" "$@"`,
      ''
    ].join('\n')
    const wrapper = join(dir, 'atelier')
    await writeFile(wrapper, sh, 'utf8')
    await chmod(wrapper, 0o755)
  }

  log.info('cli-install', `atelier instalado em ${dir}`)
}
