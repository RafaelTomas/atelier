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
 * Faz também uma terceira coisa, que não é conserto e sim identidade: em dev o
 * app roda dentro do bundle do Electron que veio no node_modules, então o Dock
 * mostra o nome e o ícone DELE. Renomear esse bundle é o único jeito de o dev
 * ver "Atelier" — no app empacotado quem cuida disso é o electron-builder.
 *
 * Idempotente e seguro de rodar em qualquer plataforma.
 */
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const APP_NAME = 'Atelier'
const ELECTRON_DIST = join(ROOT, 'node_modules/electron/dist')

/**
 * O bundle do Electron em dev, já renomeado ou ainda de fábrica.
 *
 * O nome da PASTA importa: o Dock e o Spotlight tiram o rótulo do
 * kMDItemDisplayName, que sai do nome do arquivo quando o bundle não veio da
 * App Store — com Electron.app no disco, o Dock mostra "Electron" mesmo com o
 * Info.plist inteiro dizendo outra coisa.
 */
function electronAppPath() {
  const renamed = join(ELECTRON_DIST, `${APP_NAME}.app`)
  return existsSync(renamed) ? renamed : join(ELECTRON_DIST, 'Electron.app')
}

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
  const appPath = electronAppPath()
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

// ─── 3. identidade do Electron em dev (nome e ícone no Dock) ─────────────────

function plistGet(plist, key) {
  try {
    return execFileSync('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, plist], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim()
  } catch {
    return null // chave ausente
  }
}

function plistSet(plist, key, value) {
  const verb = plistGet(plist, key) === null ? 'Add' : 'Set'
  const arg = verb === 'Add' ? `Add :${key} string ${value}` : `Set :${key} ${value}`
  execFileSync('/usr/libexec/PlistBuddy', ['-c', arg, plist], { stdio: 'pipe' })
}

/** PNG → .icns pelo caminho oficial da Apple (iconset + iconutil). */
function buildIcns(pngPath, outPath) {
  const work = mkdtempSync(join(tmpdir(), 'atelier-icon-'))
  const iconset = join(work, 'icon.iconset')
  execFileSync('mkdir', ['-p', iconset])
  try {
    // Os pares que o iconutil exige: tamanho base e a variante @2x.
    for (const [size, name] of [
      [16, 'icon_16x16.png'],
      [32, 'icon_16x16@2x.png'],
      [32, 'icon_32x32.png'],
      [64, 'icon_32x32@2x.png'],
      [128, 'icon_128x128.png'],
      [256, 'icon_128x128@2x.png'],
      [256, 'icon_256x256.png'],
      [512, 'icon_256x256@2x.png'],
      [512, 'icon_512x512.png'],
      [1024, 'icon_512x512@2x.png']
    ]) {
      execFileSync(
        'sips',
        ['-z', String(size), String(size), pngPath, '--out', join(iconset, name)],
        { stdio: 'pipe' }
      )
    }
    execFileSync('iconutil', ['-c', 'icns', iconset, '-o', outPath], { stdio: 'pipe' })
    return true
  } catch (err) {
    console.warn('[fix-native-deps] não foi possível gerar o .icns:', err.message)
    return false
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

function brandElectronForDev() {
  if (process.platform !== 'darwin') return

  const icon = join(ROOT, 'build', 'icon.png')
  const current = electronAppPath()
  if (!existsSync(current) || !existsSync(icon)) return

  const target = join(ELECTRON_DIST, `${APP_NAME}.app`)
  const plist = join(target, 'Contents', 'Info.plist')
  const icns = join(target, 'Contents', 'Resources', 'atelier.icns')
  const binary = join(target, 'Contents', 'MacOS', APP_NAME)
  const pathTxt = join(ROOT, 'node_modules/electron/path.txt')

  // Idempotência: pasta, binário, plist e ícone no lugar — não mexe de novo
  // (mexer custaria uma re-assinatura a cada npm install).
  if (
    current === target &&
    existsSync(binary) &&
    existsSync(icns) &&
    plistGet(plist, 'CFBundleName') === APP_NAME
  ) {
    return
  }

  try {
    // 1. A pasta. É daqui que sai o rótulo do Dock.
    if (current !== target) renameSync(current, target)

    // 2. O executável — é o nome que aparece no Activity Monitor e o fallback
    //    do Dock quando o banco do LaunchServices está velho.
    if (!existsSync(binary)) renameSync(join(target, 'Contents', 'MacOS', 'Electron'), binary)

    // 3. O path.txt: é por ele que o pacote `electron` (e portanto o
    //    electron-vite) descobre o que executar. Sem isto, npm run dev quebra.
    writeFileSync(pathTxt, `${APP_NAME}.app/Contents/MacOS/${APP_NAME}`, 'utf8')

    // 4. As chaves do bundle e o ícone.
    if (!existsSync(icns) && !buildIcns(icon, icns)) return
    plistSet(plist, 'CFBundleName', APP_NAME)
    plistSet(plist, 'CFBundleDisplayName', APP_NAME)
    plistSet(plist, 'CFBundleExecutable', APP_NAME)
    plistSet(plist, 'CFBundleIconFile', 'atelier')

    // 5. Editar o bundle invalida a assinatura: sem re-assinar, o Gatekeeper
    //    mata o processo — o mesmo sintoma do item 2 acima.
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', target], { stdio: 'pipe' })

    // 6. O Dock lê nome e ícone do banco do LaunchServices, que guarda o que
    //    viu da primeira vez; sem reregistrar, o rótulo demora a virar.
    try {
      execFileSync(
        '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister',
        ['-f', target],
        { stdio: 'pipe' }
      )
    } catch {
      /* lsregister é undocumented: se mudar de lugar, seguimos sem ele */
    }

    console.log(`[fix-native-deps] Electron de dev renomeado para "${APP_NAME}" com o ícone do app`)
  } catch (err) {
    // Nada aqui é essencial: sem isto o dev roda igual, só com nome de Electron
    console.warn('[fix-native-deps] não foi possível renomear o Electron de dev:', err.message)
  }
}

fixSpawnHelper()
fixElectronSignature()
brandElectronForDev()
