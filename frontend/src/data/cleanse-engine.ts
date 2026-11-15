/** 数据清洗纯逻辑：分隔文本解析、去重、键表/结果生成、内容摘要。
 *  这里不碰 localStorage；批次边界与版本快照由 cleanse-service 负责。
 *
 *  去重边界 = 批次 + 规则版本：调用方只传入同键域的首条来源索引（键 → 行号），
 *  不传整行数据；索引随批次增量装载，避免一次装载全部历史记录。
 */

export type ParsedTable = {
  columns: string[]
  rows: string[][]
}

/** 键表一行：只记被删除的后续重复行，首条保留行留在结果里。 */
export type DedupKeyEntry = {
  sourceRow: number
  key: string
  /** 同键首次出现的来源行号（同键域内，可能来自更早的批次） */
  duplicateOf: number
  /** 同键首次出现所在批次号 */
  duplicateOfBatch: string
  /** 判定该行重复时使用的规则版本（批次快照） */
  ruleVersion: string
}

export type DedupResultRow = {
  /** 本轮结果内行号（从 1 开始；服务层续跑时按批次累计） */
  resultNo: number
  sourceRow: number
  key: string
  values: Record<string, string>
}

/** 键域索引条目：只保留键与首条来源，不保留整行。 */
export type DedupIndexEntry = {
  key: string
  sourceRow: number
  batchNo: string
  ruleVersion: string
}

export type DedupOutcome = {
  /** 本轮被删除的后续重复行 */
  keyEntries: DedupKeyEntry[]
  /** 本轮保留下来的结果行 */
  results: DedupResultRow[]
  /** 本轮结束后的键域索引（已有键 + 本轮新键） */
  index: DedupIndexEntry[]
}

export type DedupOptions = {
  columns: string[]
  rows: string[][]
  /** rows[0] 在原始记录中的来源行号（从 1 开始，不含表头） */
  sourceStart: number
  dedupColumns: string[]
  ruleVersion: string
  batchNo: string
  /** 同版本键域里已有的首条来源；不含整行数据 */
  knownKeys?: DedupIndexEntry[]
  /** 本次最多处理多少行；达到上限就停在批次边界，等待下一轮续跑 */
  limit?: number
}

export type DedupProgress = {
  outcome: DedupOutcome
  processedNow: number
  done: boolean
}

/** 去掉首尾空白、内部空白与常见分隔符，避免 138-0000-1111 与 13800001111 被当成两个键。 */
export function normalizeKeyPart(value: string): string {
  return value.trim().replace(/\s+/g, '').replace(/[-－—–()（）]/g, '')
}

export function buildKey(values: Record<string, string>, dedupColumns: string[]): string {
  return dedupColumns
    .map((column) => normalizeKeyPart(values[column] ?? ''))
    .join(' | ')
}

function assertDedupColumns(columns: string[], dedupColumns: string[]): string[] {
  const normalized = dedupColumns.map((column) => column.trim()).filter(Boolean)
  if (normalized.length === 0) {
    throw new Error('清洗规则没有配置去重键列')
  }
  for (const column of normalized) {
    if (!columns.includes(column)) {
      throw new Error(`去重键列「${column}」不在原始记录表头中`)
    }
  }
  return normalized
}

/**
 * 去重：从 sourceStart 开始处理最多 limit 行。
 * 相同键只删除后续重复，首条保留；键索引只存「键 → 首条来源」。
 */
export function dedupBatch(options: DedupOptions): DedupProgress {
  const { columns, rows, sourceStart, ruleVersion, batchNo } = options
  const dedupColumns = assertDedupColumns(columns, options.dedupColumns)
  const limit = options.limit ?? rows.length

  const index = new Map<string, DedupIndexEntry>()
  for (const item of options.knownKeys ?? []) {
    if (!index.has(item.key)) {
      index.set(item.key, item)
    }
  }

  const keyEntries: DedupKeyEntry[] = []
  const results: DedupResultRow[] = []
  const end = Math.min(rows.length, Math.max(0, limit))
  let processedNow = 0

  for (let offset = 0; offset < end; offset += 1) {
    const sourceRow = sourceStart + offset
    const cells = rows[offset] ?? []
    const values: Record<string, string> = {}
    columns.forEach((column, cellIndex) => {
      values[column] = cells[cellIndex] ?? ''
    })
    const key = buildKey(values, dedupColumns)
    processedNow += 1

    if (key.split(' | ').every((part) => part === '')) {
      // 空键行不做去重，但仍然保留在结果里。
      results.push({ resultNo: results.length + 1, sourceRow, key: '', values })
      continue
    }
    const first = index.get(key)
    if (first === undefined) {
      index.set(key, { key, sourceRow, batchNo, ruleVersion })
      results.push({ resultNo: results.length + 1, sourceRow, key, values })
      continue
    }
    // 相同键只删除后续重复，首条保留；键表记录来源行与首条位置，便于回溯。
    keyEntries.push({
      sourceRow,
      key,
      duplicateOf: first.sourceRow,
      duplicateOfBatch: first.batchNo,
      ruleVersion,
    })
  }

  const done = processedNow >= rows.length
  return {
    outcome: { keyEntries, results, index: Array.from(index.values()) },
    processedNow,
    done,
  }
}

/** 兼容一次性处理的调用：等价于 limit 拉满。 */
export function dedupOnce(options: Omit<DedupOptions, 'limit'>): DedupOutcome {
  return dedupBatch({ ...options, limit: options.rows.length }).outcome
}

function detectDelimiter(text: string): string {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? ''
  const candidates = [',', '\t', ';', '|']
  let best = ','
  let bestCount = -1
  for (const candidate of candidates) {
    const count = firstLine.split(candidate).length - 1
    if (count > bestCount) {
      best = candidate
      bestCount = count
    }
  }
  return best
}

/** 解析 CSV/TSV：支持双引号包裹、"" 转义、字段内换行；首行作为表头。 */
export function parseDelimited(text: string, delimiter?: string): ParsedTable {
  const normalized = text.replace(/^﻿/, '')
  const sep = delimiter ?? detectDelimiter(normalized)
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false

  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index]
    if (inQuotes) {
      if (char === '"') {
        if (normalized[index + 1] === '"') {
          field += '"'
          index += 1
        } else {
          inQuotes = false
        }
      } else {
        field += char
      }
      continue
    }
    if (char === '"') {
      inQuotes = true
    } else if (char === sep) {
      row.push(field)
      field = ''
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && normalized[index + 1] === '\n') {
        index += 1
      }
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else {
      field += char
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }

  const nonEmpty = rows.filter((cells) => cells.some((cell) => cell.trim() !== ''))
  if (nonEmpty.length === 0) {
    throw new Error('没有可导入的记录')
  }
  const headerCells = nonEmpty[0].map((cell) => cell.trim())
  const columns: string[] = []
  headerCells.forEach((cell, index) => {
    const name = cell === '' ? `列${index + 1}` : cell
    columns.push(columns.includes(name) ? `${name}_${index + 1}` : name)
  })
  const dataRows = nonEmpty.slice(1).map((cells) => columns.map((_, index) => cells[index] ?? ''))
  if (dataRows.length === 0) {
    throw new Error('原始记录只有表头，没有数据行')
  }
  return { columns, rows: dataRows }
}

export function csvCell(value: string | number): string {
  const text = String(value)
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`
  }
  return text
}

export function toCsv(columns: string[], rows: (string | number)[][]): string {
  const lines = [columns.map(csvCell).join(',')]
  for (const row of rows) {
    lines.push(row.map(csvCell).join(','))
  }
  return lines.join('\n')
}

/** FNV-1a 64 位摘要：同一内容得到同一摘要，用于阻止同一份文件重复导入。 */
export function digestText(text: string): string {
  let hash = 0xcbf29ce484222325n
  const mask = 0xffffffffffffffffn
  for (let index = 0; index < text.length; index += 1) {
    hash ^= BigInt(text.charCodeAt(index))
    hash = (hash * 0x100000001b3n) & mask
  }
  return hash.toString(16).padStart(16, '0')
}
