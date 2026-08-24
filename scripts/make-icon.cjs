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
const SIZE = 1024

if (!process.versions.electron) {
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
