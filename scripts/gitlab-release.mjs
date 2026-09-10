/**
 * Publica a release no GitLab a partir dos instaladores já empacotados em dist/.
 *
 * Três diferenças em relação ao release.yml do GitHub mudam o desenho, e nenhuma
 * é cosmética:
 *
 * 1. A release do GitLab NÃO hospeda arquivo. Ela guarda uma lista de links, e o
 *    binário precisa existir em outro lugar antes — aqui, no Package Registry
 *    genérico do próprio projeto. Por isso o upload vem primeiro, e a release
 *    depois, apontando para as URLs que o upload devolveu.
 *
 * 2. A API de releases não devolve o TAMANHO do asset; a do GitHub devolvia, e a
 *    página de download imprimia "12,4 MB" a partir dela. Quem resolve agora é um
 *    HEAD em tempo de build (ver site/src/pages/download.astro), e ele só funciona
 *    porque o Package Registry responde `Content-Length` — é mais uma razão para
 *    o binário morar lá, e não num artefato de job.
 *
 * 3. Não existe `generate_release_notes`. As notas saem do `git log` desde a tag
 *    anterior, o que exige clone completo — ver `GIT_DEPTH: 0` no .gitlab-ci.yml.
 *    Sem tag anterior (a primeira release), sai só o cabeçalho.
 *
 * Autentica com `CI_JOB_TOKEN`, a mesma credencial que o `release-cli` usaria.
 * Node 22 tem `fetch` e `crypto` nativos: nada a instalar no runner.
 *
 * `--dry-run` monta tudo e imprime, sem subir nada. É como isto é verificado
 * fora do CI.
 */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readdir, stat, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { Readable } from 'node:stream'
import { join } from 'node:path'

const DIST = 'dist'
const PACKAGE = 'atelier'

// O que é instalável. O diretório `linux-unpacked` e os `.blockmap` do
// electron-builder ficam de fora: o primeiro é enorme e não se distribui, o
// segundo só serve para o updater diferencial, que este app não usa.
const INSTALLERS = /\.(AppImage|deb|zip|dmg|exe)$/i

const dryRun = process.argv.includes('--dry-run')

const env = (name) => {
  const value = process.env[name]
  if (!value && !dryRun) throw new Error(`${name} ausente — este script roda dentro do CI do GitLab`)
  return value ?? `<${name}>`
}

const apiUrl = env('CI_API_V4_URL')
const projectId = env('CI_PROJECT_ID')
const tag = env('CI_COMMIT_TAG')
const jobToken = process.env.CI_JOB_TOKEN

// A tag é `v0.1.0`; a versão do pacote, `0.1.0`. O registry aceita as duas, mas
// uma URL com `v` duplicaria o prefixo no nome do arquivo baixado.
const version = tag.replace(/^v/, '')
const packageBase = `${apiUrl}/projects/${projectId}/packages/generic/${PACKAGE}/${version}`

const installers = (await readdir(DIST, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && INSTALLERS.test(entry.name))
  .map((entry) => entry.name)
  .sort()

if (installers.length === 0) {
  throw new Error(`nenhum instalador em ${DIST}/ — o job de empacotamento não deixou o que publicar`)
}

// O checksums.txt sai daqui, e não de um `sha256sum` no shell, porque é ele que
// a página de download lê para imprimir o SHA-256 de cada binário: o formato
// (`<hash>  <nome>`) precisa bater com o que ela espera, e o arquivo precisa
// subir junto dos outros. Ver o parser em site/src/pages/download.astro.
const checksums = []
for (const name of installers) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(join(DIST, name))) hash.update(chunk)
  checksums.push(`${hash.digest('hex')}  ${name}`)
}
await writeFile(join(DIST, 'checksums.txt'), `${checksums.join('\n')}\n`)

const assets = [...installers, 'checksums.txt']

/**
 * Sobe um arquivo por streaming.
 *
 * `duplex: 'half'` não é opcional: sem ele o `fetch` do Node recusa um corpo que
 * é stream. Ler o arquivo inteiro na memória seria a alternativa, e um `.zip` de
 * centenas de MB por vez dentro de um contêiner de CI é como se descobre o
 * limite de memória do runner.
 */
async function upload(name) {
  const path = join(DIST, name)
  const { size } = await stat(path)
  const url = `${packageBase}/${encodeURIComponent(name)}`

  if (dryRun) {
    console.log(`  PUT ${url}  (${(size / 1024 / 1024).toFixed(1)} MB)`)
    return url
  }

  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'JOB-TOKEN': jobToken, 'Content-Length': String(size) },
    body: Readable.toWeb(createReadStream(path)),
    duplex: 'half'
  })
  if (!res.ok) throw new Error(`upload de ${name} falhou: ${res.status} ${await res.text()}`)
  return url
}

/**
 * As notas da release, a partir dos commits desde a tag anterior.
 *
 * `git describe` no PAI da tag é o que acha a anterior sem listar e ordenar
 * tudo. Falha na primeira release (não há tag anterior) e num clone raso — nos
 * dois casos a release sai com o cabeçalho e sem a lista, que é degradar, não
 * quebrar: a release em si é o que importa.
 */
function releaseNotes() {
  // stderr ignorado: a falha esperada aqui ("No names found") é fluxo normal na
  // primeira release, e o `catch` abaixo já a trata. Deixá-la vazar pintaria de
  // vermelho um log de job que deu certo.
  const git = (args) =>
    execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  // Quais sistemas realmente saíram: o job de macOS só roda se a instância tiver
  // um runner macOS, então a lista é do que foi empacotado, não do que se
  // pretendia empacotar.
  const sistemas = [
    installers.some((n) => /\.(dmg)$/i.test(n)) && 'macOS',
    installers.some((n) => /\.exe$/i.test(n)) && 'Windows',
    installers.some((n) => /\.(AppImage|deb)$/i.test(n)) && 'Linux'
  ].filter(Boolean)
  const cabecalho = `Instaladores para ${sistemas.join(', ') || 'nenhum sistema'} — \`${tag}\`.`

  try {
    const previous = git(['describe', '--tags', '--abbrev=0', `${tag}^`])
    const log = git(['log', '--no-merges', '--pretty=- %s', `${previous}..${tag}`])
    return `${cabecalho}\n\n## Mudanças desde ${previous}\n\n${log}`
  } catch {
    return cabecalho
  }
}

console.log(`Release ${tag} — ${assets.length} assets`)
const links = []
for (const name of assets) links.push({ name, url: await upload(name), link_type: 'package' })

const body = {
  name: `Atelier ${tag}`,
  tag_name: tag,
  description: releaseNotes(),
  assets: { links }
}

if (dryRun) {
  console.log(JSON.stringify(body, null, 2))
  process.exit(0)
}

const res = await fetch(`${apiUrl}/projects/${projectId}/releases`, {
  method: 'POST',
  headers: { 'JOB-TOKEN': jobToken, 'Content-Type': 'application/json' },
  body: JSON.stringify(body)
})
if (!res.ok) throw new Error(`criação da release falhou: ${res.status} ${await res.text()}`)
console.log(`Release ${tag} publicada com ${links.length} assets.`)
