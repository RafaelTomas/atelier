// Guarda o vocabulário: "maestri"/"maestro" não voltam ao código.
//
// O nome do app nativo de onde este projeto foi portado saiu dos comentários
// (docs/2026-08-30-PLANO-um-mestre-so.md), e o badge "maestro" saiu da
// interface: quem manda no canvas é o Artesão, e ele é o único mestre.
//
// A palavra volta por cópia. Um comentário antigo colado num arquivo novo, um
// merge de branch velha, um "porte de X.swift" reaproveitado — nada disso
// quebra teste nenhum, e é assim que o vocabulário de um produto se desfaz.
//
// Duas EXCEÇÕES, e as duas são o endereço de dados que não são nossos:
//
//   • persistence/import-legacy.ts importa `~/.open-maestri`, a pasta do app
//     antigo, e grava `.imported-from-open-maestri` como marcador. Renomear o
//     primeiro faz a importação nunca achar nada — o bug que o arquivo existe
//     para evitar; o segundo já está gravado em máquinas reais.
//   • scripts/smoke-headless.mjs testa exatamente essa importação, então os
//     literais são o objeto do teste.
//
// O campo `isManager` continua no formato em disco de propósito, e por isso NÃO
// entra aqui: `encodeNodeContent` serializa por spread, então tirar o campo do
// tipo tira a chave do JSON, e o `Codable` do app nativo a decodifica como
// `Bool` não-opcional. Ver a Decisão B do plano.

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Onde procurar. */
const AREAS = ['src', 'scripts', 'resources']

/** Arquivos onde a palavra é o endereço do app antigo, não um nome nosso. */
const EXCECOES = new Map([
  ['src/main/core/persistence/import-legacy.ts', 'a pasta e o marcador do app antigo, em disco'],
  ['scripts/smoke-headless.mjs', 'testa a importação dessa pasta'],
  ['scripts/test-vocabulario.mjs', 'é este arquivo']
])

const EXTENSOES = ['.ts', '.tsx', '.js', '.mjs', '.cjs', '.css', '.html', '.json']
const PALAVRA = /maestr/i

let falhas = 0
const fail = (msg) => { console.error(`  ✗ ${msg}`); falhas++ }

function arquivos(dir) {
  const saida = []
  for (const nome of readdirSync(dir)) {
    if (nome === 'node_modules' || nome.startsWith('.')) continue
    const caminho = join(dir, nome)
    if (statSync(caminho).isDirectory()) saida.push(...arquivos(caminho))
    else if (EXTENSOES.some((e) => nome.endsWith(e))) saida.push(caminho)
  }
  return saida
}

console.log('\nvocabulário: um mestre só\n')

const encontrados = []
for (const area of AREAS) {
  for (const caminho of arquivos(join(root, area))) {
    const rel = relative(root, caminho).split('\\').join('/')
    const linhas = readFileSync(caminho, 'utf8').split('\n')
    linhas.forEach((linha, i) => {
      if (PALAVRA.test(linha)) encontrados.push({ rel, n: i + 1, linha: linha.trim() })
    })
  }
}

for (const { rel, n, linha } of encontrados) {
  if (EXCECOES.has(rel)) continue
  fail(
    `${rel}:${n} — "maestr" voltou ao código:\n     ${linha}\n` +
    `     O app nativo se descreve ("o formato do app nativo"), e quem manda no canvas é o Artesão.\n` +
    `     Se for mesmo o endereço da pasta do app antigo, some em EXCEÇÕES com o motivo.`
  )
}

const usadas = new Set(encontrados.map((e) => e.rel).filter((r) => EXCECOES.has(r)))
for (const [rel, motivo] of EXCECOES) {
  if (rel === 'scripts/test-vocabulario.mjs') continue
  if (!usadas.has(rel)) {
    fail(`exceção obsoleta: ${rel} já não cita a palavra (${motivo}). Tire-a de EXCEÇÕES.`)
  }
}

if (!falhas) {
  console.log(`  ✓ nenhuma menção fora das ${EXCECOES.size - 1} exceções (${encontrados.length} ocorrência(s) no total)`)
}

if (falhas) { console.error(`\ntest-vocabulario: ${falhas} falha(s)`); process.exit(1) }
console.log('test-vocabulario: ok')
