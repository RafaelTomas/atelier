/**
 * Parser dos dados tabulares que o agente entrega ao `atelier table`.
 *
 * Compartilhado entre main (o handler do CLI) e renderer (o nó que mostra a
 * grade). Não depende de nada do Electron nem de lib externa — CSV/TSV têm um
 * parser mínimo próprio, com suporte a aspas.
 *
 * Fase 1 é snapshot: o resultado chega pronto, o Atelier nunca fala com o banco.
 */

export type DataCell = string | number | boolean | null

/** Forma em disco (`tables/<id>.json`) e em memória no renderer. */
export interface DataTablePayload {
  columns: string[]
  rows: DataCell[][]
  truncated: boolean
}

export type TabularFormat = 'auto' | 'json' | 'csv' | 'tsv'

export interface TabularLimits {
  /** Teto de linhas. Excedeu → corta e marca `truncated`. */
  maxRows: number
  /** Teto de células (linhas × colunas). */
  maxCells: number
}

export const DEFAULT_TABULAR_LIMITS: TabularLimits = { maxRows: 2000, maxCells: 200_000 }

/** Erro de dados malformados — a mensagem vai crua para o agente. */
export class TabularParseError extends Error {}

/**
 * Detecta o formato de `raw`:
 *   • começa com `[` ou `{` (após espaços)         → json
 *   • contém tab antes da primeira quebra de linha → tsv
 *   • senão                                        → csv
 */
export function detectFormat(raw: string): Exclude<TabularFormat, 'auto'> {
  const trimmed = raw.trimStart()
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) return 'json'
  const firstLine = raw.split(/\r?\n/, 1)[0] ?? ''
  if (firstLine.includes('\t')) return 'tsv'
  return 'csv'
}

/**
 * `raw` → `{ columns, rows, truncated }`. Lança `TabularParseError` em dado
 * malformado (JSON inválido, header ausente, forma `{columns,rows}` incoerente).
 */
export function parseTabular(
  raw: string,
  format: TabularFormat = 'auto',
  limits: TabularLimits = DEFAULT_TABULAR_LIMITS
): DataTablePayload {
  const resolved = format === 'auto' ? detectFormat(raw) : format
  const parsed = resolved === 'json' ? parseJSON(raw) : parseDelimited(raw, resolved === 'tsv' ? '\t' : ',')
  return applyLimits(parsed.columns, parsed.rows, limits)
}

// ─── JSON ─────────────────────────────────────────────────────────────────────

function parseJSON(raw: string): { columns: string[]; rows: DataCell[][] } {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch (err) {
    throw new TabularParseError(`JSON inválido: ${(err as Error).message}`)
  }

  // Forma explícita: { columns: [...], rows: [[...]] }
  if (value && typeof value === 'object' && !Array.isArray(value) && 'columns' in value) {
    const o = value as Record<string, unknown>
    if (!Array.isArray(o.columns) || !o.columns.every((c) => typeof c === 'string')) {
      throw new TabularParseError('`columns` deve ser um array de strings')
    }
    if (!Array.isArray(o.rows)) throw new TabularParseError('`rows` deve ser um array')
    const columns = o.columns as string[]
    const rows = (o.rows as unknown[]).map((row, i) => {
      if (!Array.isArray(row)) throw new TabularParseError(`linha ${i} não é um array`)
      const cells = row.map(toCell)
      // Normaliza o comprimento à contagem de colunas.
      while (cells.length < columns.length) cells.push(null)
      return cells.slice(0, columns.length)
    })
    return { columns, rows }
  }

  // Array de objetos: colunas = união das chaves, na ordem de 1ª ocorrência.
  if (Array.isArray(value)) {
    if (value.length === 0) return { columns: [], rows: [] }
    const columns: string[] = []
    const seen = new Set<string>()
    for (const item of value) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        throw new TabularParseError('array JSON deve conter objetos')
      }
      for (const key of Object.keys(item)) {
        if (!seen.has(key)) {
          seen.add(key)
          columns.push(key)
        }
      }
    }
    const rows = (value as Record<string, unknown>[]).map((item) =>
      columns.map((col) => (col in item ? toCell(item[col]) : null))
    )
    return { columns, rows }
  }

  throw new TabularParseError('JSON deve ser um array de objetos ou { columns, rows }')
}

function toCell(value: unknown): DataCell {
  if (value === null || value === undefined) return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value)
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') return value
  // Objeto/array aninhado: serializa, para não quebrar a grade.
  return JSON.stringify(value)
}

// ─── CSV / TSV ────────────────────────────────────────────────────────────────

/**
 * Parser mínimo com aspas duplas no estilo RFC 4180: `""` dentro de campo
 * citado é uma aspa literal, delimitador e quebra de linha dentro de aspas são
 * texto. A primeira linha é sempre o header.
 */
function parseDelimited(raw: string, delimiter: string): { columns: string[]; rows: DataCell[][] } {
  const records = splitRecords(raw, delimiter)
  if (records.length === 0) throw new TabularParseError('nenhum dado — a primeira linha deve ser o header')

  const columns = records[0]
  const rows: DataCell[][] = []
  for (let i = 1; i < records.length; i++) {
    const record = records[i]
    // Linha em branco no fim do texto é ignorada.
    if (record.length === 1 && record[0] === '') continue
    const cells: DataCell[] = columns.map((_, c) => normalizeScalar(record[c] ?? ''))
    rows.push(cells)
  }
  return { columns, rows }
}

function splitRecords(raw: string, delimiter: string): string[][] {
  const records: string[][] = []
  let field = ''
  let record: string[] = []
  let inQuotes = false
  let i = 0

  const pushField = (): void => {
    record.push(field)
    field = ''
  }
  const pushRecord = (): void => {
    pushField()
    records.push(record)
    record = []
  }

  while (i < raw.length) {
    const ch = raw[i]
    if (inQuotes) {
      if (ch === '"') {
        if (raw[i + 1] === '"') {
          field += '"'
          i += 2
          continue
        }
        inQuotes = false
        i++
        continue
      }
      field += ch
      i++
      continue
    }
    if (ch === '"') {
      inQuotes = true
      i++
      continue
    }
    if (ch === delimiter) {
      pushField()
      i++
      continue
    }
    if (ch === '\r') {
      i++
      continue
    }
    if (ch === '\n') {
      pushRecord()
      i++
      continue
    }
    field += ch
    i++
  }
  // Último registro (arquivo sem quebra de linha no fim).
  if (field.length > 0 || record.length > 0) pushRecord()
  return records
}

/** CSV não tem tipos: só reconhecemos vazio como null e número puro como número. */
function normalizeScalar(text: string): DataCell {
  if (text === '') return null
  if (/^-?\d+(\.\d+)?$/.test(text)) {
    const n = Number(text)
    if (Number.isFinite(n)) return n
  }
  return text
}

// ─── Limites ──────────────────────────────────────────────────────────────────

function applyLimits(columns: string[], rows: DataCell[][], limits: TabularLimits): DataTablePayload {
  let truncated = false
  let capped = rows

  if (capped.length > limits.maxRows) {
    capped = capped.slice(0, limits.maxRows)
    truncated = true
  }
  const maxRowsByCells = columns.length > 0 ? Math.floor(limits.maxCells / columns.length) : capped.length
  if (capped.length > maxRowsByCells) {
    capped = capped.slice(0, Math.max(0, maxRowsByCells))
    truncated = true
  }
  return { columns, rows: capped, truncated }
}

/** Serializa a grade de volta para CSV — o botão "copiar CSV" do nó. */
export function toCSV(payload: DataTablePayload): string {
  const escape = (cell: DataCell): string => {
    if (cell === null) return ''
    const text = String(cell)
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
  }
  const lines = [payload.columns.map((c) => escape(c)).join(',')]
  for (const row of payload.rows) lines.push(row.map(escape).join(','))
  return lines.join('\n')
}
