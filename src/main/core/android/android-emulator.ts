/**
 * O emulador do Android Studio, achado e listado — sem SDK nenhum embutido.
 *
 * O binário `emulator` já sabe listar os AVDs que o Android Studio criou
 * (`-list-avds`), então este módulo não lê `~/.android/avd/*.ini` à mão: é
 * o mesmo comando que o próprio Android Studio roda por baixo, e segue certo
 * mesmo que o formato dos arquivos de AVD mude entre versões do SDK.
 *
 * ─── Onde o binário mora, quando não está no PATH ───
 *
 * O `emulator` quase nunca está no PATH — só o `platform-tools` costuma
 * entrar lá. As duas variáveis de ambiente do SDK (`ANDROID_SDK_ROOT`, a
 * atual, e `ANDROID_HOME`, a antiga que o Android Studio ainda exporta) vêm
 * primeiro; sem nenhuma das duas, cai no caminho padrão de instalação de
 * cada sistema. `resolveCandidates` é pura — só monta a lista, não toca em
 * disco — para o teste não depender de um SDK de verdade instalado.
 *
 * Módulo sem `electron` — roda no smoke headless.
 */
import { access, constants } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { childEnv } from '../subprocess-env'

/** `emulator -list-avds` custa um boot pequeno do SDK — não é instantâneo, mas não deveria passar disto. */
const LIST_TIMEOUT_MS = 10_000

/** Onde cada sistema instala o SDK quando nenhuma variável de ambiente aponta pra outro lugar. */
function defaultSdkRoot(platform: string, env: NodeJS.ProcessEnv, home: string): string {
  if (platform === 'darwin') return join(home, 'Library', 'Android', 'sdk')
  if (platform === 'win32') return join(env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'Android', 'Sdk')
  return join(home, 'Android', 'Sdk')
}

/**
 * Os caminhos candidatos, na ORDEM em que valem: `ANDROID_SDK_ROOT`, depois
 * `ANDROID_HOME` (a mesma prioridade que as próprias ferramentas do Android
 * usam entre as duas), e por último o padrão do sistema. Duplicata (as duas
 * variáveis apontando pro mesmo lugar) não sai repetida.
 */
export function resolveCandidates(env: NodeJS.ProcessEnv, platform: string, home: string): string[] {
  const exe = platform === 'win32' ? 'emulator.exe' : 'emulator'
  const roots = [env.ANDROID_SDK_ROOT, env.ANDROID_HOME, defaultSdkRoot(platform, env, home)].filter(
    (v): v is string => !!v && v.trim().length > 0
  )
  const seen = new Set<string>()
  const paths: string[] = []
  for (const root of roots) {
    const p = join(root, 'emulator', exe)
    if (seen.has(p)) continue
    seen.add(p)
    paths.push(p)
  }
  return paths
}

/** O primeiro candidato que existe e é executável. `null` = SDK não encontrado. */
export async function findEmulatorBinary(
  env: NodeJS.ProcessEnv = process.env,
  platform: string = process.platform,
  home: string = homedir()
): Promise<string | null> {
  for (const candidate of resolveCandidates(env, platform, home)) {
    try {
      await access(candidate, constants.X_OK)
      return candidate
    } catch {
      // Não é este candidato — tenta o próximo.
    }
  }
  return null
}

/** Uma linha em branco (comum no fim da saída) não vira um AVD chamado "". */
export function parseAvdList(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
}

export type AvdListResult = { ok: true; emulatorPath: string; avds: string[] } | { ok: false; error: string }

/**
 * Acha o binário e lista os AVDs dele, os dois passos de uma vez — é o que o
 * diálogo do dock precisa. `findEmulatorBinary`/`parseAvdList` continuam
 * exportadas à parte porque são a metade TESTÁVEL sem um SDK de verdade
 * instalado na máquina que roda o teste.
 */
export async function listAvds(): Promise<AvdListResult> {
  const emulatorPath = await findEmulatorBinary()
  if (!emulatorPath) {
    return {
      ok: false,
      error:
        'Emulador do Android não encontrado. Instale o Android Studio, ou aponte ANDROID_SDK_ROOT/ANDROID_HOME para o seu SDK.'
    }
  }

  return new Promise((resolve) => {
    execFile(
      emulatorPath,
      ['-list-avds'],
      { env: childEnv(), timeout: LIST_TIMEOUT_MS, windowsHide: true },
      (err, stdout) => {
        if (err) {
          const timedOut = (err as Error & { killed?: boolean }).killed === true
          resolve({
            ok: false,
            error: timedOut ? 'o emulador não respondeu a tempo ao listar os dispositivos' : err.message
          })
          return
        }
        resolve({ ok: true, emulatorPath, avds: parseAvdList(String(stdout ?? '')) })
      }
    )
  })
}
