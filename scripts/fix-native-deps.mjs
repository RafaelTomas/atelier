/**
 * Conserta dois problemas de dependência nativa que quebram o app logo depois
 * de `npm install`. Ambos foram reproduzidos aqui; ambos dão erros opacos.
 *
 * 1. spawn-helper do node-pty sem bit de execução (macOS/Linux)
 *    Sintoma: "posix_spawnp failed." ao abrir qualquer terminal.
 *    Causa: os binários em node-pty/prebuilds/ chegam 0644 em algumas
 *    combinações de npm/tarball; o helper precisa ser executável.
 *
 * 2. Notarização do Electron revogada (macOS)
 *    Sintoma: "exited with signal SIGKILL", sem mais nada — parece bug do app.
 *    Causa: a Apple revogou o ticket de notarização de algumas versões do
 *    Electron; o Gatekeeper mata o processo na hora.
 *    `spctl -a -vv` confirma: "notarization indicates this code has been revoked".
 *    Re-assinar ad-hoc substitui a assinatura revogada. Não afeta distribuição —
 *    o app empacotado é assinado pelo electron-builder.
 *
 * Idempotente e seguro de rodar em qualquer plataforma.
 */
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')

// ─── 1. bit de execução do spawn-helper ───────────────────────────────────────

function fixSpawnHelper() {
  if (process.platform === 'win32') return
  const prebuilds = join(ROOT, 'node_modules/node-pty/prebuilds')
  if (!existsSync(prebuilds)) return

  for (const dir of readdirSync(prebuilds)) {
    const helper = join(prebuilds, dir, 'spawn-helper')
    if (!existsSync(helper)) continue
    const mode = statSync(helper).mode
    if (mode & 0o111) continue // já executável
    chmodSync(helper, 0o755)
    console.log(`[fix-native-deps] +x em prebuilds/${dir}/spawn-helper`)
  }
}

// ─── 2. assinatura revogada do Electron ───────────────────────────────────────

function fixElectronSignature() {
  if (process.platform !== 'darwin') return
  const appPath = join(ROOT, 'node_modules/electron/dist/Electron.app')
  if (!existsSync(appPath)) return

  let output = ''
  try {
    output = execFileSync('spctl', ['-a', '-vv', appPath], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    })
  } catch (err) {
    // spctl sai != 0 quando reprova — é justamente o caso que tratamos
    output = `${err.stdout ?? ''}${err.stderr ?? ''}`
  }
  if (!/revoked/i.test(output)) return

  try {
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'pipe' })
    console.log('[fix-native-deps] assinatura revogada do Electron substituída por ad-hoc')
  } catch (err) {
    console.warn('[fix-native-deps] falha ao re-assinar o Electron:', err.message)
    console.warn(`  contorno manual: codesign --force --deep --sign - "${appPath}"`)
  }
}

fixSpawnHelper()
fixElectronSignature()
