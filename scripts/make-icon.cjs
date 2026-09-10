/**
 * Gera build/icon.png a partir de build/icon.svg.
 *
 * Renderiza com o próprio Electron (já é devDependency) em vez de exigir
 * rsvg/ImageMagick/Inkscape: o Chromium que desenha o app é o mesmo que
 * desenha o ícone, então o que está no SVG é o que sai no PNG.
 *
 * CommonJS de propósito, e não .mjs como os outros scripts: o Electron aceita
 * .mjs como ENTRADA do processo main só em parte — aqui ele sobe sem executar
 * o arquivo e fica pendurado com a janela padrão. Em .cjs roda.
 *
 * O electron-builder consome só este PNG de 1024 — .icns e .ico ele gera.
 *
 * Uso: node scripts/make-icon.cjs
 */
const { readFileSync, writeFileSync } = require('node:fs')
const { spawn } = require('node:child_process')
const { join, resolve } = require('node:path')

const ROOT = resolve(__dirname, '..')
const SVG = join(ROOT, 'build', 'icon.svg')
const PNG = join(ROOT, 'build', 'icon.png')
const FAVICON = join(ROOT, 'site', 'public', 'favicon.svg')
const SIZE = 1024

/**
 * O favicon do site é o MESMO desenho, sem a margem do macOS.
 *
 * A grade de 824 dentro de 1024 existe porque o Dock espera essa folga. Numa
 * aba de navegador ela vira ~10% de vazio em cada lado, e o ícone aparece
 * visivelmente menor que os vizinhos. Recortar o `viewBox` no tile resolve sem
 * tocar em uma linha do desenho.
 *
 * Sai daqui, e não de uma cópia feita à mão, porque duas cópias do mesmo SVG
 * divergem no primeiro ajuste que alguém fizer só numa delas. Roda na fase 1:
 * é transformação de texto, não precisa do Chromium.
 */
function writeSiteFavicon() {
  const svg = readFileSync(SVG, 'utf8')
  const original = 'width="1024" height="1024" viewBox="0 0 1024 1024"'
  if (!svg.includes(original)) {
    throw new Error(`o <svg> de build/icon.svg mudou de forma: esperava ${original}`)
  }
  const cropped = svg.replace(original, 'width="824" height="824" viewBox="100 100 824 824"')

  // O cabeçalho do original diz "editou aqui? rode npm run icon", e nesta cópia
  // isso seria mentira: editar o arquivo gerado não muda nada, e o próximo
  // `npm run icon` apagaria a edição sem avisar.
  const aviso = `<!--\n  GERADO por scripts/make-icon.cjs a partir de build/icon.svg — não edite.\n\n  É o mesmo desenho com o viewBox recortado no tile: a margem de 100px da\n  grade do macOS deixaria o favicon menor que os vizinhos na aba.\n-->`
  writeFileSync(FAVICON, cropped.replace(/<!--[\s\S]*?-->/, aviso))
  console.log('favicon do site:', FAVICON)
}

if (!process.versions.electron) {
  writeSiteFavicon()

  // Fase 1: estamos no node comum — reexecuta dentro do Electron.
  const electronPath = require('electron')
  const child = spawn(electronPath, [__filename], {
    stdio: 'inherit',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined }
  })
  child.on('exit', (code) => process.exit(code ?? 1))
} else {
  // Fase 2: dentro do Electron, com Chromium disponível.
  const { app, BrowserWindow } = require('electron')

  app.whenReady().then(async () => {
    const svg = readFileSync(SVG, 'utf8')
    const win = new BrowserWindow({
      width: SIZE,
      height: SIZE,
      show: false,
      frame: false,
      // Sem transparência o PNG sai com fundo em vez das bordas vazadas
      transparent: true,
      backgroundColor: '#00000000'
    })

    const page = `<style>html,body{margin:0;background:transparent}svg{display:block}</style>${svg}`
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(page)}`)

    // Janela oculta só pinta um frame depois do load: capturar antes disso
    // devolve bitmap vazio.
    await new Promise((r) => setTimeout(r, 400))

    const image = await win.webContents.capturePage()
    const size = image.getSize()
    if (size.width !== SIZE || size.height !== SIZE) {
      // Tela com escala != 1 devolve o bitmap em pontos, não em pixels
      writeFileSync(PNG, image.resize({ width: SIZE, height: SIZE, quality: 'best' }).toPNG())
    } else {
      writeFileSync(PNG, image.toPNG())
    }

    console.log(`icon: build/icon.png (${SIZE}×${SIZE})`)
    app.exit(0)
  })
}
