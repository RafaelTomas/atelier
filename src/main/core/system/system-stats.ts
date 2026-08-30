/**
 * Amostrador de recursos da máquina — o bloco PC do widget de monitor.
 *
 * Sem dependência nova. `systeminformation` traria binários nativos por
 * plataforma para medir três coisas que o próprio Node já mede: `os.cpus()`,
 * `os.freemem()` e `fs.statfs()`. O que ele mediria a mais (temperatura, GPU,
 * tabela de processos) não é o escopo do widget.
 *
 * O arquivo tem duas metades, e a divisão é a mesma de `agent-status.ts`:
 *
 *  - a parte PURA (`readCpuTimes`, `sampleCpu`, `usageFrom`, `sumAppMetrics`)
 *    não importa `electron` e recebe os snapshots por parâmetro, então o smoke
 *    headless a exercita sem abrir janela;
 *  - a CASCA (`SystemStatsMonitor`) tem o timer, o ref-count e o único ponto
 *    que toca `electron` — `app.getAppMetrics()`, por import dinâmico, para o
 *    módulo continuar importável fora do app.
 *
 * O amostrador é ÚNICO e ref-contado de propósito: dez nós de monitor no canvas
 * não são dez timers. Zoom afastado e virtualização desmontam nós, então o
 * assinante vai e volta o tempo todo — o mesmo motivo pelo qual o portal
 * precisou do `portal-wake`.
 */
import { statfs } from 'node:fs/promises'
import os from 'node:os'
import type { SystemStats } from '@shared/types'

// ─── Parte pura ───────────────────────────────────────────────────────────────

/** Soma dos contadores de tempo de CPU sobre todos os núcleos. */
export interface CpuTimes {
  idle: number
  total: number
}

/**
 * Retrato dos contadores de `os.cpus()`, somados sobre os núcleos.
 *
 * Somar antes de derivar (em vez de calcular por núcleo e tirar a média) é o
 * que faz o número bater com o que o sistema chama de "CPU total" quando os
 * núcleos têm frequências ou tempos ligados diferentes.
 */
export function readCpuTimes(cpus: os.CpuInfo[] = os.cpus()): CpuTimes {
  let idle = 0
  let total = 0
  for (const cpu of cpus) {
    const t = cpu.times
    idle += t.idle
    total += t.user + t.nice + t.sys + t.idle + t.irq
  }
  return { idle, total }
}

/**
 * Percentual de CPU entre DUAS amostras. `null` quando não há delta utilizável.
 *
 * Três casos devolvem `null`, e nenhum deles é erro:
 *
 *  - `prev` ausente — a primeira amostra depois de ligar o timer não tem com o
 *    que comparar. Um `0%` ali seria um número inventado: a máquina pode estar
 *    a 100%. O widget mostra `—` por um período, e é a leitura honesta.
 *  - delta de tempo zero — duas leituras dentro do mesmo tick do relógio.
 *  - delta NEGATIVO — contador reiniciado (suspensão, núcleo saindo de linha).
 *    Sem esta guarda o resultado sairia `-40%` ou `NaN`, e a barra do widget
 *    desenharia para fora do nó.
 */
export function sampleCpu(prev: CpuTimes | null, now: CpuTimes): number | null {
  if (!prev) return null
  const totalDelta = now.total - prev.total
  const idleDelta = now.idle - prev.idle
  if (totalDelta <= 0 || idleDelta < 0) return null
  const pct = ((totalDelta - idleDelta) / totalDelta) * 100
  // O clamp cobre o resto: idle andar mais que total é aritmeticamente
  // impossível, mas contadores de 32 bits dão a volta em uptime longo.
  return Math.max(0, Math.min(100, Math.round(pct * 10) / 10))
}

/**
 * Uso de um volume a partir de um `statfs`.
 *
 * `bavail`, e não `bfree`: o espaço reservado ao root não está disponível para
 * quem clona um repositório, e contá-lo como livre mentiria justamente no
 * momento em que o disco aperta.
 */
export function usageFrom(stat: { bsize: number; blocks: number; bavail: number }): {
  used: number
  total: number
} {
  const total = stat.bsize * stat.blocks
  const free = stat.bsize * stat.bavail
  return { used: Math.max(0, total - free), total }
}

/**
 * Espaço do volume que contém `path`. Zeros quando o caminho não responde.
 *
 * Um disco ilegível (volume de rede caído, diretório apagado embaixo do
 * workspace) não derruba a amostra inteira: o resto dos números continua válido
 * e o widget mostra `—` só na linha do disco.
 *
 * `fs.promises.statfs` existe desde o Node 18.15 — o Electron do projeto está
 * bem acima disso.
 */
export async function readDisk(
  path: string
): Promise<{ used: number; total: number; path: string }> {
  if (!path) return { used: 0, total: 0, path: '' }
  try {
    const stat = await statfs(path)
    const { used, total } = usageFrom({
      bsize: Number(stat.bsize),
      blocks: Number(stat.blocks),
      bavail: Number(stat.bavail)
    })
    return { used, total, path }
  } catch {
    return { used: 0, total: 0, path: '' }
  }
}

/**
 * `os.loadavg()[0]`, ou `null` onde ele não significa nada.
 *
 * O Node devolve `[0, 0, 0]` no Windows — não porque a máquina esteja parada,
 * mas porque o sistema não tem o conceito. Um `0,00` na tela seria lido como
 * "sem carga"; `null` faz o campo SUMIR da UI, que é a leitura honesta.
 */
export function readLoadAvg(platform: string = process.platform): number | null {
  if (platform === 'win32') return null
  const [one] = os.loadavg()
  return Math.round(one * 100) / 100
}

/** Uma entrada de `app.getAppMetrics()`, no que interessa aqui. */
export interface AppMetricSample {
  cpu?: { percentCPUUsage?: number }
  memory?: { workingSetSize?: number }
}

/**
 * O "quanto EU custo": main + renderers + PTYs filhos, somados.
 *
 * É a métrica que interessa quando o usuário tem oito terminais abertos e a
 * máquina engasga — a pergunta não é "quanto o sistema usa", é "sou eu?". Vai
 * como UMA linha na UI, nunca como tabela de processos: perfilador não é o
 * escopo deste widget.
 *
 * `workingSetSize` vem em KILOBYTES no Electron, daí o × 1024.
 */
export function sumAppMetrics(metrics: AppMetricSample[]): {
  cpuPct: number
  memBytes: number
} {
  let cpuPct = 0
  let memBytes = 0
  for (const m of metrics) {
    cpuPct += m.cpu?.percentCPUUsage ?? 0
    memBytes += (m.memory?.workingSetSize ?? 0) * 1024
  }
  return { cpuPct: Math.round(cpuPct * 10) / 10, memBytes }
}

// ─── A casca: um timer, ref-contado ───────────────────────────────────────────

/**
 * Import dinâmico do `electron` pela mesma razão de `ipc/notify.ts`: fora do
 * app (smoke, CI) isto vira zero em vez de quebrar a importação do núcleo.
 */
async function appMetrics(): Promise<{ cpuPct: number; memBytes: number }> {
  try {
    const { app } = await import('electron')
    return sumAppMetrics(app.getAppMetrics() as AppMetricSample[])
  } catch {
    return { cpuPct: 0, memBytes: 0 }
  }
}

export class SystemStatsMonitor {
  /**
   * O período pedido por CADA assinante vivo, um por entrada — não um contador.
   *
   * Um número simples bastaria para ligar e desligar o timer, mas não para o
   * `view.interval`: dois monitores na tela, um a 1s e outro a 5s, precisam do
   * MAIS RÁPIDO dos dois, e quando o de 1s desmonta o timer tem de afrouxar
   * para 5s de novo. Guardar os períodos é o que permite recalcular o mínimo a
   * cada entrada e cada saída. `refCount` é o tamanho desta lista.
   */
  private subs: number[] = []
  private timer: NodeJS.Timeout | null = null
  /** Período com que o timer ATUAL foi criado — o mínimo de `subs`. */
  private activeIntervalMs = 0
  private prevCpu: CpuTimes | null = null
  private diskPath = ''

  constructor(
    private emit: (stats: SystemStats) => void,
    /** Período padrão, para quem assina sem pedir um. */
    private defaultIntervalMs: number
  ) {}

  /** Volume observado. Vazio = a amostra vem sem linha de disco. */
  setDiskPath(path: string): void {
    this.diskPath = path
  }

  get running(): boolean {
    return this.timer !== null
  }

  get refCount(): number {
    return this.subs.length
  }

  /** Período efetivo do timer, em ms. 0 = parado. */
  get intervalMs(): number {
    return this.activeIntervalMs
  }

  subscribe(intervalMs = this.defaultIntervalMs): void {
    this.subs.push(intervalMs > 0 ? intervalMs : this.defaultIntervalMs)
    this.retime()
  }

  unsubscribe(intervalMs = this.defaultIntervalMs): void {
    // Remove UMA ocorrência, não todas: dois monitores pedindo 2s são duas
    // entradas, e o desmonte de um não pode levar o outro junto.
    const i = this.subs.indexOf(intervalMs > 0 ? intervalMs : this.defaultIntervalMs)
    // Um período que não está na lista é o `unsubscribe` de um renderer que
    // recarregou depois de o main já ter zerado tudo — descarta em silêncio, em
    // vez de deixar o contador negativo e o próximo `subscribe` sem timer.
    if (i >= 0) this.subs.splice(i, 1)
    this.retime()
  }

  /** Zera tudo — a janela sumiu (recarga em dev, fechamento). */
  reset(): void {
    this.subs = []
    this.stop()
  }

  /**
   * Liga, desliga ou re-cria o timer conforme quem está assinando agora. Só
   * re-cria quando o período MUDOU: sem essa guarda, cada monitor montado
   * reiniciaria o timer e zeraria o delta de CPU de todos os outros.
   */
  private retime(): void {
    if (this.subs.length === 0) {
      this.stop()
      return
    }
    const wanted = Math.min(...this.subs)
    if (this.timer && wanted === this.activeIntervalMs) return
    this.stop()
    this.start(wanted)
  }

  private start(intervalMs: number): void {
    // O delta de CPU da sessão anterior não vale: entre desligar e religar o
    // timer passou um tempo arbitrário, e o percentual sairia diluído nele.
    this.prevCpu = null
    this.activeIntervalMs = intervalMs
    this.timer = setInterval(() => void this.tick(), intervalMs)
    // O monitor não é razão para o processo continuar vivo.
    this.timer.unref?.()
    void this.tick()
  }

  private stop(): void {
    if (!this.timer) return
    clearInterval(this.timer)
    this.timer = null
    this.activeIntervalMs = 0
    this.prevCpu = null
  }

  private async tick(): Promise<void> {
    const now = readCpuTimes()
    const cpuPct = sampleCpu(this.prevCpu, now)
    this.prevCpu = now

    const [disk, app] = await Promise.all([readDisk(this.diskPath), appMetrics()])

    // A amostra pode ficar pronta DEPOIS de o último assinante ter saído (os
    // `await` acima levam um tick): emiti-la mandaria dado para um widget que
    // já desmontou, e é exatamente o vazamento que o ref-count existe para não ter.
    if (!this.timer) return

    this.emit({
      cpuPct,
      loadAvg: readLoadAvg(),
      memUsed: os.totalmem() - os.freemem(),
      memTotal: os.totalmem(),
      diskUsed: disk.used,
      diskTotal: disk.total,
      diskPath: disk.path,
      appCpuPct: app.cpuPct,
      appMemBytes: app.memBytes,
      at: new Date().toISOString()
    })
  }
}
