/**
 * Importa os dados do app nativo (~/.open-maestri) no primeiro boot.
 *
 * O rename para Atelier trocou o diretório de dados, então sem isto quem já usa
 * o app Swift abriria o Atelier com o canvas vazio e concluiria, com razão, que
 * perdeu tudo.
 *
 * É uma CÓPIA, não uma movimentação: o app nativo continua funcionando com os
 * dados originais. A partir daí os dois divergem — é o custo do rename completo,
 * e está documentado no README.
 *
 * Os dois literais abaixo NÃO são um nome nosso e não mudam com o rename: eles
 * são o endereço em disco do app antigo. `.open-maestri` é a pasta que ele
 * criou — renomear o literal faria a importação nunca mais achar nada, e quem
 * vem de lá abriria o canvas vazio. `.imported-from-open-maestri` é o marcador
 * que este módulo grava, e já existe em máquinas reais — trocar o nome faria o
 * Atelier achar que nunca importou.
 *
 * Roda uma vez só e apenas quando:
 *   • o diretório do Atelier ainda não existe (nada a perder), E
 *   • estamos usando o caminho padrão (ATELIER_HOME não foi apontado para outro
 *     lugar) — senão um `npm run dev` copiaria dados reais para o diretório de
 *     desenvolvimento, quebrando o isolamento que o dev script promete.
 */
import { cp, mkdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, sep } from 'node:path'
import { log } from '../logger'
import { dataDir } from './paths'

const LEGACY_DIR_NAME = '.open-maestri'
const MARKER = '.imported-from-open-maestri'

export interface ImportResult {
  imported: boolean
  from?: string
  reason?: string
}

/** Os overrides existem para teste; em produção nada é passado. */
export interface ImportOptions {
  legacyDir?: string
  targetDir?: string
  respectHomeOverride?: boolean
}

export async function importLegacyDataIfNeeded(opts: ImportOptions = {}): Promise<ImportResult> {
  const respectHomeOverride = opts.respectHomeOverride ?? true
  if (respectHomeOverride && process.env.ATELIER_HOME) {
    return { imported: false, reason: 'ATELIER_HOME definido — importação pulada' }
  }

  const target = opts.targetDir ?? dataDir()
  if (existsSync(target)) return { imported: false, reason: 'diretório já existe' }

  const legacy = opts.legacyDir ?? join(homedir(), LEGACY_DIR_NAME)
  if (!existsSync(legacy)) return { imported: false, reason: 'nada a importar' }

  try {
    await mkdir(target, { recursive: true })

    // `run/` é socket e `bin/` é o CLI antigo: ambos são recriados no boot
    const skip = [join(legacy, 'run'), join(legacy, 'bin')]
    await cp(legacy, target, {
      recursive: true,
      filter: (src) => !skip.some((dir) => src === dir || src.startsWith(`${dir}${sep}`))
    })

    await writeFile(
      join(target, MARKER),
      `Dados copiados de ${legacy} em ${new Date().toISOString()}.\n` +
        'O app nativo segue usando o diretório original — a partir daqui os dois divergem.\n',
      'utf8'
    )

    log.info('import', `dados importados de ${legacy} (cópia, o original ficou intacto)`)
    return { imported: true, from: legacy }
  } catch (err) {
    log.error('import', 'falha ao importar dados do app nativo', err)
    return { imported: false, reason: (err as Error).message }
  }
}
