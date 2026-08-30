import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { PassThrough } from 'node:stream'
import * as esbuild from 'esbuild'

const ROOT = resolve(import.meta.dirname, '..')

const outdir = await mkdtemp(join(tmpdir(), 'atelier-codex-protocol-'))
const outfile = join(outdir, 'protocol.mjs')
await esbuild.build({
  stdin: {
    contents: `
      export { CodexJsonRpcClient, sanitizeStderr } from './src/main/core/codex/codex-protocol.ts'
    `,
    resolveDir: ROOT,
    loader: 'ts'
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile,
  logLevel: 'silent'
})

const { CodexJsonRpcClient, sanitizeStderr } = await import(pathToFileURL(outfile).href)

let passed = 0
let failed = 0
async function test(name, fn) {
  try {
    await fn()
    passed++
    console.log(`  ok  ${name}`)
  } catch (err) {
    failed++
    console.error(`  FAIL ${name}`)
    console.error(`       ${err.message}`)
  }
}

class FakeChild extends EventEmitter {
  stdin = new PassThrough()
  stdout = new PassThrough()
  stderr = new PassThrough()
  killed = false
  kill() {
    this.killed = true
    this.emit('exit', null, 'SIGTERM')
    return true
  }
}

function lines(stream) {
  const out = []
  let buffer = ''
  stream.on('data', (chunk) => {
    buffer += chunk.toString('utf8')
    for (;;) {
      const idx = buffer.indexOf('\n')
      if (idx < 0) break
      out.push(JSON.parse(buffer.slice(0, idx)))
      buffer = buffer.slice(idx + 1)
    }
  })
  return out
}

console.log('\ncodex protocol\n')

await test('handshake initialize writes JSON-RPC request', async () => {
  const child = new FakeChild()
  const sent = lines(child.stdin)
  const client = new CodexJsonRpcClient(child)
  const p = client.initialize({ clientInfo: { name: 'atelier' } })
  await new Promise((r) => setTimeout(r, 0))
  assert.equal(sent[0].method, 'initialize')
  child.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: sent[0].id, result: { ok: true } }) + '\n')
  assert.deepEqual(await p, { ok: true })
})

await test('concurrent requests can resolve out of order and receive notifications', async () => {
  const child = new FakeChild()
  const sent = lines(child.stdin)
  const notifications = []
  const client = new CodexJsonRpcClient(child, {
    onNotification: (method, params) => notifications.push([method, params])
  })
  const a = client.request('a')
  const b = client.request('b')
  await new Promise((r) => setTimeout(r, 0))
  child.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'account/updated', params: { planType: 'plus' } }) + '\n')
  child.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: sent[1].id, result: 'B' }) + '\n')
  child.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: sent[0].id, result: 'A' }) + '\n')
  assert.equal(await b, 'B')
  assert.equal(await a, 'A')
  assert.deepEqual(notifications, [['account/updated', { planType: 'plus' }]])
})

await test('broken JSON line does not kill pending requests', async () => {
  const child = new FakeChild()
  const sent = lines(child.stdin)
  const client = new CodexJsonRpcClient(child)
  const p = client.request('ok')
  await new Promise((r) => setTimeout(r, 0))
  child.stdout.write('{nope\n')
  child.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: sent[0].id, result: 42 }) + '\n')
  assert.equal(await p, 42)
})

await test('timeout removes pending request', async () => {
  const child = new FakeChild()
  const client = new CodexJsonRpcClient(child, { requestTimeoutMs: 10 })
  const keepAlive = setTimeout(() => undefined, 50)
  try {
    await assert.rejects(() => client.request('slow'), /timed out/)
  } finally {
    clearTimeout(keepAlive)
  }
})

await test('exit rejects all pending requests', async () => {
  const child = new FakeChild()
  const client = new CodexJsonRpcClient(child, { requestTimeoutMs: 1000 })
  const p = client.request('never')
  child.emit('exit', 1, null)
  await assert.rejects(() => p, /exited/)
})

await test('an unknown notification and an orphan response are ignored', async () => {
  // O App Server se atualiza sozinho, sem passar por este codigo. Metodo novo,
  // params de forma desconhecida e resposta de um id que ninguem espera mais
  // (o timeout ja passou) nao podem derrubar o canal.
  const child = new FakeChild()
  const sent = lines(child.stdin)
  const seen = []
  const client = new CodexJsonRpcClient(child, {
    onNotification: (method, params) => seen.push([method, params])
  })
  const p = client.request('depois')
  await new Promise((r) => setTimeout(r, 0))
  child.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'thread/somethingNew', params: 7 }) + '\n')
  child.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 9999, result: 'de ninguem' }) + '\n')
  child.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 'texto', result: 'id errado' }) + '\n')
  child.stdout.write('null\n')
  child.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: sent[0].id, result: 'chegou' }) + '\n')
  assert.equal(await p, 'chegou')
  assert.deepEqual(seen, [['thread/somethingNew', 7]])
})

await test('an error response rejects with the message the server gave', async () => {
  const child = new FakeChild()
  const sent = lines(child.stdin)
  const client = new CodexJsonRpcClient(child)
  const p = client.request('account/usage/read')
  await new Promise((r) => setTimeout(r, 0))
  child.stdout.write(
    JSON.stringify({
      jsonrpc: '2.0',
      id: sent[0].id,
      error: { code: -32000, message: 'not available for api key auth' }
    }) + '\n'
  )
  await assert.rejects(() => p, /not available for api key auth/)
})

await test('close kills the child, rejects what was pending and refuses new requests', async () => {
  // O sidecar e observabilidade: o ultimo assinante o encerra, e o que estava
  // no ar precisa falhar de forma limpa em vez de ficar pendurado para sempre.
  const child = new FakeChild()
  const client = new CodexJsonRpcClient(child, { requestTimeoutMs: 1000 })
  const p = client.request('no ar')
  client.close()
  assert.equal(child.killed, true)
  await assert.rejects(() => p, /closed/)
  await assert.rejects(() => client.request('depois de fechar'), /closed/)
})

await test('the current camelCase payloads survive a full round trip', async () => {
  // Fixture com a forma publicada pelo `codex-cli` verificado: se o protocolo
  // mudar de caixa ou de nome, e aqui que a mudanca aparece.
  const child = new FakeChild()
  const sent = lines(child.stdin)
  const client = new CodexJsonRpcClient(child)
  const p = client.request('account/rateLimits/read')
  await new Promise((r) => setTimeout(r, 0))
  const snapshot = {
    rateLimitsByLimitId: {
      primary: { usedPercentage: 4, windowDurationMins: 300, resetsAt: 1756512000 },
      secondary: { usedPercentage: 1, windowDurationMins: 10080, resetsAt: 1757116800 }
    }
  }
  child.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: sent[0].id, result: snapshot }) + '\n')
  assert.deepEqual(await p, snapshot, 'o cliente entrega o payload cru — quem normaliza e agent-usage')
})

await test('stderr sanitizer redacts token-like values', () => {
  assert.equal(
    sanitizeStderr('access_token="secret" refreshToken=abc id_token: xyz ok'),
    'access_token=[redacted] refreshToken=[redacted] id_token: [redacted] ok'
  )
})

await rm(outdir, { recursive: true, force: true })

console.log(`\n${passed} passaram, ${failed} falharam\n`)
process.exit(failed === 0 ? 0 : 1)
