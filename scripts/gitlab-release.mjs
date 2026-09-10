/**
 * Publica a release no GitLab. Roda em dois modos, e a divisão não é estética.
 *
 *   --upload <plataforma>   sobe o que está em dist/ para o Package Registry e
 *                           deixa um dist/links-<plataforma>.json com nome, URL
 *                           e sha256 de cada arquivo.
 *   (sem argumento)         junta os links-*.json de todas as plataformas, sobe
 *                           o checksums.txt somado e cria a release.
 *
 * Por que dois modos: o artefato de job tem teto de tamanho na instância (o
 * upload de ~280 MB de instaladores de Linux voltou 413), e passar binário de um
 * job para o outro por lá era desperdício mesmo antes do limite — o Package
 * Registry é quem hospeda de verdade, e é para onde os links da release apontam.
 * O que trafega entre os jobs agora são algumas centenas de bytes de JSON.
 *
 * Três diferenças em relação ao release.yml do GitHub explicam o resto:
 *
 * 1. A release do GitLab NÃO hospeda arquivo — ela guarda uma lista de links.
 *    Por isso o upload vem primeiro e a release depois.
 *
 * 2. A API não devolve o TAMANHO do asset; a do GitHub devolvia, e era dela que
 *    saía o "12,4 MB" na página de download. Quem resolve agora é um HEAD em
 *    tempo de build (ver site/src/pages/download.astro), e ele só funciona
 *    porque o Package Registry responde `Content-Length`.
 *
 * 3. Não existe `generate_release_notes`. As notas saem do `git log` desde a tag
 *    anterior, o que exige clone completo — ver `GIT_DEPTH: 0` no .gitlab-ci.yml.
 *
 * Autentica com `CI_JOB_TOKEN`, a mesma credencial que o `release-cli` usaria.
 * Node 22 tem `fetch` e `crypto` nativos: nada a instalar no runner.
 *
 * `--dry-run` monta tudo e imprime, sem subir nada.
 */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { Readable } from 'node:stream'
import { join } from 'node:path'

const DIST = 'dist'
const PACKAGE = 'atelier'

// O que é instalável. `dist/*-unpacked` e os `.blockmap` ficam de fora: o
// primeiro é enorme e não se distribui, o segundo só serve para updater
// diferencial, que este app não usa.
const INSTALLERS = /\.(AppImage|deb|zip|dmg|exe)$/i

// O que o Package Registry aceita como nome de arquivo. Um espaço — o padrão do
// NSIS era "Atelier Setup 0.1.0.exe" — volta como 400 `file_name is invalid`,
// sem dizer qual arquivo nem qual caractere. A checagem aqui em cima transforma
// isso numa mensagem que diz o que fazer.
const NOME_ACEITO = /^[A-Za-z0-9._+-]+$/

const dryRun = process.argv.includes('--dry-run')
const uploadIndex = process.argv.indexOf('--upload')
const platform = uploadIndex === -1 ? null : process.argv[uploadIndex + 1]

if (uploadIndex !== -1 && !platform) {
  throw new Error('--upload exige o nome da plataforma (ex.: --upload linux)')
}

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

/**
 * Sobe um arquivo por streaming.
 *
 * `duplex: 'half'` não é opcional: sem ele o `fetch` do Node recusa um corpo que
 * é stream. Ler o arquivo inteiro na memória seria a alternativa, e um `.zip` de
 * centenas de MB por vez dentro de um contêiner de CI é como se descobre o
 * limite de memória do runner.
 */
async function upload(name) {
  if (!NOME_ACEITO.test(name)) {
    throw new Error(
      `"${name}" não serve como nome no Package Registry: só [A-Za-z0-9._+-]. ` +
        'Ajuste o `artifactName` do alvo em electron-builder.yml.'
    )
  }

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

async function sha256(name) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(join(DIST, name))) hash.update(chunk)
  return hash.digest('hex')
}

// ------------------------------------------------------------------ modo upload

if (platform) {
  const installers = (await readdir(DIST, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && INSTALLERS.test(entry.name))
    .map((entry) => entry.name)
    .sort()

  if (installers.length === 0) {
    throw new Error(`nenhum instalador em ${DIST}/ — o empacotamento de ${platform} não deixou o que publicar`)
  }

  console.log(`${platform}: ${installers.length} instaladores`)
  const assets = []
  for (const name of installers) {
    assets.push({ name, sha256: await sha256(name), url: await upload(name) })
  }

  const manifest = join(DIST, `links-${platform}.json`)
  await writeFile(manifest, `${JSON.stringify({ platform, assets }, null, 2)}\n`)
  console.log(`manifesto: ${manifest}`)
  process.exit(0)
}

// ----------------------------------------------------------------- modo release

const manifests = (await readdir(DIST, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && /^links-.+\.json$/.test(entry.name))
  .map((entry) => entry.name)
  .sort()

if (manifests.length === 0) {
  throw new Error(`nenhum links-*.json em ${DIST}/ — nenhum job de empacotamento chegou a subir arquivo`)
}

const assets = []
for (const name of manifests) {
  const { assets: doPlataforma } = JSON.parse(await readFile(join(DIST, name), 'utf8'))
  assets.push(...doPlataforma)
}

// O checksums.txt é somado aqui, e não em cada job, porque é um arquivo só com
// os hashes de TODOS os sistemas — e é ele que a página de download lê para
// imprimir o SHA-256 de cada binário. O formato (`<hash>  <nome>`) precisa bater
// com o parser em site/src/pages/download.astro.
const checksums = assets.map((a) => `${a.sha256}  ${a.name}`).join('\n')
await writeFile(join(DIST, 'checksums.txt'), `${checksums}\n`)
const checksumsUrl = await upload('checksums.txt')

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
  const nomes = assets.map((a) => a.name)
  const sistemas = [
    nomes.some((n) => /\.dmg$/i.test(n)) && 'macOS',
    nomes.some((n) => /\.exe$/i.test(n)) && 'Windows',
    nomes.some((n) => /\.(AppImage|deb)$/i.test(n)) && 'Linux'
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

/**
 * Cada link ganha um `direct_asset_path`, e é ele que torna o botão de download
 * clicável para uma pessoa.
 *
 * A `url` aponta para a API do Package Registry, que num projeto privado só
 * responde a quem manda token — um visitante logado no GitLab clicando nela
 * recebe 404. Com o `direct_asset_path`, a release passa a expor também
 * `<projeto>/-/releases/<tag>/downloads/<arquivo>`, que é rota da aplicação web
 * e portanto aceita a sessão do navegador. É essa URL que a API devolve como
 * `direct_asset_url`, e é a que a página de download prefere.
 */
const links = [...assets, { name: 'checksums.txt', url: checksumsUrl }].map(({ name, url }) => ({
  name,
  url,
  direct_asset_path: `/${name}`,
  link_type: 'package'
}))

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
