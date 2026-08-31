/**
 * Servidor estatico de `docs/` — Node puro, sem `express`.
 *
 * E o que o no Portal da demo abre. Sem dependencia porque a demo roda
 * offline e `npm install` nao acontece no palco. Serve so a pasta `docs/`,
 * resolve `/` para `index.html`, e recusa qualquer caminho que escape da
 * pasta (o `..` classico). A porta vem de `PORT` — o gerador escolhe uma
 * livre quando 4173 esta ocupada — com 4173 de padrao.
 */
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join, normalize, extname } from 'node:path'
import { fileURLToPath } from 'node:url'

const RAIZ = fileURLToPath(new URL('../docs/', import.meta.url))
const PORTA = Number(process.env.PORT) || 4173

const TIPOS = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
}

const servidor = createServer(async (req, res) => {
  // So GET/HEAD; o resto nao faz sentido para pagina estatica.
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405).end('Method Not Allowed')
    return
  }

  const caminhoPedido = decodeURIComponent(new URL(req.url, 'http://x').pathname)
  const relativo = normalize(caminhoPedido).replace(/^(\.\.[/\\])+/, '')
  const arquivo = join(RAIZ, relativo === '/' || relativo === '' ? 'index.html' : relativo)

  // Trava anti-escape: o alvo resolvido tem que continuar dentro de RAIZ.
  if (!arquivo.startsWith(RAIZ)) {
    res.writeHead(403).end('Forbidden')
    return
  }

  try {
    const conteudo = await readFile(arquivo)
    res.writeHead(200, { 'content-type': TIPOS[extname(arquivo)] ?? 'application/octet-stream' })
    res.end(req.method === 'HEAD' ? undefined : conteudo)
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('404 — pagina nao encontrada')
  }
})

servidor.listen(PORTA, () => {
  // O gerador le esta URL do stdout para gravar no PortalContent.
  console.log(`Docs do demo-repo em http://localhost:${PORTA}/`)
})
