/**
 * Formato do cofre e as três funções puras que o cercam.
 *
 * Mora em `shared/` porque os dois lados precisam das MESMAS regras: o main
 * decide se pode digitar um segredo numa página (`sameOrigin`) e o que sai
 * mascarado do scrollback (`maskSecrets`); o renderer recusa um nome de chave
 * inválido (`isValidKeyName`) antes de mandá-lo ao main. Sem Electron e sem
 * `node:` nenhum — este arquivo é importável dos dois lados.
 *
 * O que NÃO mora aqui: o valor. `VaultEntry` descreve o que existe DENTRO do
 * blob cifrado; nada nesta lista chega ao renderer com `value` preenchido, e
 * `SecretVaultContent` (types.ts) é a projeção sem valor que vai ao
 * workspace.json.
 */

/** A única versão que existe. `kdf` está reservado para a passphrase futura. */
export const VAULT_FILE_VERSION = 1

export interface VaultEntry {
  key: string
  value: string
  /**
   * Origem onde este segredo pode ser digitado por `portal login`
   * ('https://github.com'). null = uso em portal PROIBIDO — a entrada serve só
   * para env do PTY e `vault get`. Default null: quem não declarou não autorizou.
   */
  origin: string | null
  /** Entra no ambiente do PTY dos terminais ligados. */
  inEnv: boolean
  note: string | null
  updatedAt: string
  /**
   * Quem gravou. 'agent' é a entrada vinda do `atelier vault set` — o agente
   * teve o valor em claro no contexto dele, então o segredo é considerado
   * QUEIMADO e o nó pede a troca. Ausente vale 'user': é o que todo `.vault`
   * gravado antes desta versão tem, e presumir 'agent' marcaria o cofre inteiro
   * de vermelho por engano.
   */
  source: 'user' | 'agent'
}

export interface VaultFile {
  version: typeof VAULT_FILE_VERSION
  /** Reservado para a passphrase da fase seguinte. Hoje sempre null. */
  kdf: null
  entries: VaultEntry[]
}

export function emptyVaultFile(): VaultFile {
  return { version: VAULT_FILE_VERSION, kdf: null, entries: [] }
}

/**
 * Decodifica o JSON que saiu do blob cifrado. **null = não decodificável.**
 *
 * Duas posturas opostas, e a diferença é o que cada erro custa:
 *
 *  • Entrada estranha DENTRO de um cofre legível é descartada — uma entrada sem
 *    `key` não tem como ser usada, e perdê-la não é perder o cofre.
 *  • Arquivo de uma versão FUTURA é recusado inteiro. Uma `version: 2` traz a
 *    camada de passphrase que o `kdf` reserva; lê-la como v1 faria o
 *    `writeVault` seguinte regravar o arquivo SEM essa camada — perda
 *    silenciosa e irreversível, o mesmo risco que o comentário do topo de
 *    persistence/migrations.ts descreve para o workspace.json. Melhor o cofre
 *    aparecer bloqueado na UI: é barulhento, e o arquivo fica intacto.
 *
 * Versão ausente vale como 1: é o que todo `.vault` gravado até aqui tem.
 */
export function decodeVaultFile(raw: unknown): VaultFile | null {
  const o = (raw ?? {}) as Record<string, unknown>
  const version = typeof o.version === 'number' ? o.version : VAULT_FILE_VERSION
  if (version > VAULT_FILE_VERSION) return null
  const list = Array.isArray(o.entries) ? o.entries : []
  const entries: VaultEntry[] = []
  for (const item of list) {
    const e = (item ?? {}) as Record<string, unknown>
    if (typeof e.key !== 'string' || !e.key) continue
    entries.push({
      key: e.key,
      value: typeof e.value === 'string' ? e.value : '',
      origin: typeof e.origin === 'string' && e.origin ? e.origin : null,
      inEnv: e.inEnv === true,
      note: typeof e.note === 'string' && e.note ? e.note : null,
      updatedAt: typeof e.updatedAt === 'string' ? e.updatedAt : '',
      source: e.source === 'agent' ? 'agent' : 'user'
    })
  }
  return { version: VAULT_FILE_VERSION, kdf: null, entries }
}

/**
 * Nome de chave: `^[A-Za-z_][A-Za-z0-9_]*$`.
 *
 * A regra é estreita porque a chave VIRA variável de ambiente do PTY — um nome
 * com hífen ou espaço não sobrevive ao `export`, e descobrir isso na hora do
 * spawn seria tarde demais.
 */
export function isValidKeyName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)
}

/**
 * A entrada nova num cofre — CRIAR, nunca sobrescrever.
 *
 * Devolve `null` quando a chave já existe, e essa recusa é a regra inteira do
 * `atelier vault set`: um agente pode acrescentar um segredo, jamais trocar o
 * valor de um que já está lá. Sobrescrever seria editar sem deixar rastro do
 * que havia antes — o usuário continuaria vendo o mesmo nome na lista, com
 * outro segredo embaixo. Apagar e recriar é ação dele, no nó.
 *
 * A ordenação por nome é a mesma do `vault:set` do bridge: a lista do nó não
 * pode depender de quem escreveu primeiro.
 */
export function withNewEntry(file: VaultFile, entry: VaultEntry): VaultFile | null {
  if (file.entries.some((e) => e.key === entry.key)) return null
  const entries = [...file.entries, entry].sort((a, b) => a.key.localeCompare(b.key))
  return { ...file, entries }
}

/**
 * Depois de quantos dias um segredo guardado pede troca.
 *
 * 90 é a higiene comum de rotação, e o número mora aqui — e não num Constants
 * do main — porque quem decide a marca é o renderer, com os mesmos dados que o
 * main usaria. Regra em dois lugares é regra que diverge.
 */
export const VAULT_ROTATE_AFTER_DAYS = 90

export type RotationReason = 'agent' | 'stale'

/**
 * Por que esta chave pede troca — ou `null` quando não pede.
 *
 * 'agent' vence 'stale' quando os dois valem: a chave que um agente viu é um
 * problema de hoje, a antiga é de manutenção, e o tooltip só cabe um motivo.
 *
 * `updatedAt` vazio ou impossível de ler NÃO marca. A data é um dado de arquivo
 * e pode faltar em cofre antigo; inventar "vencida" a partir de um campo ausente
 * ensinaria o usuário a ignorar o ícone.
 */
export function rotationReason(
  entry: { source?: 'user' | 'agent'; updatedAt?: string | null },
  now: number = Date.now()
): RotationReason | null {
  if (entry.source === 'agent') return 'agent'
  const at = entry.updatedAt ? Date.parse(entry.updatedAt) : NaN
  if (Number.isNaN(at)) return null
  return now - at > VAULT_ROTATE_AFTER_DAYS * 86_400_000 ? 'stale' : null
}

/** O que aparece no lugar do segredo. */
export const SECRET_MASK = '••••••'

/**
 * Troca cada valor conhecido pelo `SECRET_MASK`.
 *
 * Duas decisões que não são detalhe:
 *
 *  • valor vazio (ou só espaço) é IGNORADO. `''` casa em toda posição do texto,
 *    e um cofre com uma entrada em branco mascararia o scrollback inteiro.
 *  • os valores são varridos do mais longo para o mais curto. Se um valor for
 *    prefixo de outro, mascarar o curto primeiro deixaria o resto do longo
 *    visível em claro — que é exatamente o vazamento que a função existe para
 *    evitar.
 *
 * `split`/`join` em vez de regex: o valor é literal e pode conter qualquer
 * caractere, inclusive os que significam algo numa expressão regular.
 */
export function maskSecrets(text: string, values: Iterable<string>): string {
  const list = [...values].filter((v) => v.trim().length > 0).sort((a, b) => b.length - a.length)
  let out = text
  for (const value of list) {
    if (!out.includes(value)) continue
    out = out.split(value).join(SECRET_MASK)
  }
  return out
}

/**
 * A origem de uma URL no formato `esquema://host[:porta]`, ou null se a URL não
 * é analisável. Porta padrão do esquema não aparece: `https://x` e
 * `https://x:443` são a mesma origem, e é assim que o navegador as trata.
 */
export function originOf(url: string): string | null {
  try {
    const u = new URL(url)
    if (!u.protocol || !u.host) return null
    return `${u.protocol}//${u.host}`
  } catch {
    return null
  }
}

/**
 * Duas URLs (ou origens) são a MESMA origem — esquema, host e porta.
 *
 * Sem curinga e sem tolerância a subdomínio: `http` não casa com `https`,
 * `github.com` não casa com `gist.github.com`. É a trava que sustenta o
 * `portal login` inteiro, e afrouxá-la é afrouxar o produto.
 */
export function sameOrigin(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false
  const oa = originOf(a)
  const ob = originOf(b)
  if (!oa || !ob) return false
  return oa === ob
}

/**
 * Uma linha `export KEY='valor'` para o shell do agente comer.
 *
 * Mora aqui, ao lado do `maskSecrets` e do `isValidKeyName`, porque é da mesma
 * espécie: é uma TRAVA, não um utilitário. O valor de um cofre é texto
 * arbitrário — senha com `$`, com espaço, com aspas, com quebra de linha — e a
 * citação errada não falha, ela obedece: um valor com `$(...)` dentro de aspas
 * duplas VIRA EXECUÇÃO DE COMANDO no shell que fizer o `eval`.
 *
 * Aspas simples resolvem tudo isso de uma vez, porque dentro delas o shell não
 * expande nada. A única coisa que não cabe lá dentro é a própria aspa simples, e
 * o jeito de colocá-la é fechar, escapar e reabrir: `'` vira `'\''`.
 */
export function exportLine(key: string, value: string): string {
  return `export ${key}='${value.split("'").join("'\\''")}'`
}
