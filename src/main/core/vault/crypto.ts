/**
 * A primitiva de cripto do cofre — o `safeStorage` do Electron, e nada além.
 *
 * `safeStorage.encryptString`/`decryptString` cifram com uma chave do chaveiro
 * do SO (Keychain no macOS, DPAPI no Windows, libsecret/kwallet no Linux). O
 * material da chave nunca fica no repositório de dados do Atelier.
 *
 * Por que o `safeStorage` é INJETADO em vez de importado aqui: este módulo é
 * alcançado pelo `persistence-manager`, que roda também fora do Electron — o
 * smoke headless bundla o núcleo com `electron` externo, e um
 * `import { safeStorage } from 'electron'` no topo quebraria o bundle inteiro.
 * A injeção também é o que dá aos testes um `safeStorage` de mentira sem
 * precisar de janela.
 *
 * Sem chaveiro (ou sem injeção), `available()` responde false e o Atelier
 * RECUSA criar ou ler cofre — em vez de cair para texto em claro em silêncio.
 */
import { log } from '../logger'

export interface SafeStorageLike {
  isEncryptionAvailable(): boolean
  encryptString(plainText: string): Buffer
  decryptString(encrypted: Buffer): string
}

let impl: SafeStorageLike | null = null

/** Chamado no boot com o `safeStorage` do Electron (e pelos testes, com o mock). */
export function useSafeStorage(storage: SafeStorageLike | null): void {
  impl = storage
}

/** Dá para cifrar neste sistema? false = cofre bloqueado, e o nó diz isso. */
export function vaultEncryptionAvailable(): boolean {
  try {
    return impl?.isEncryptionAvailable() === true
  } catch (err) {
    log.warn('vault', 'safeStorage não respondeu — cofre tratado como bloqueado', err)
    return false
  }
}

/**
 * Texto → base64 do blob cifrado. Base64 porque o `.vault` é gravado pela
 * `atomicWrite`, que escreve texto; os bytes crus não sobreviveriam a utf8.
 */
export function encryptToBase64(plainText: string): string | null {
  if (!vaultEncryptionAvailable() || !impl) return null
  try {
    return impl.encryptString(plainText).toString('base64')
  } catch (err) {
    log.error('vault', 'falha cifrando o cofre', err)
    return null
  }
}

/** base64 do blob → texto. null = chaveiro ausente ou blob de outro sistema. */
export function decryptFromBase64(base64: string): string | null {
  if (!vaultEncryptionAvailable() || !impl) return null
  try {
    return impl.decryptString(Buffer.from(base64, 'base64'))
  } catch (err) {
    log.error('vault', 'falha decifrando o cofre (chaveiro trocado?)', err)
    return null
  }
}
