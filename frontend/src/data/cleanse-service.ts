import { dedupBatch, digestText, parseDelimited, toCsv } from './cleanse-engine'
import type {
  CleanseBatch,
  CleanseBatchMeta,
  CleanseKeyDomain,
  CleanseState,
  CleanseUploadRecord,
  CreateBatchResult,
  MappingSnapshot,
  ProcessBatchResult,
  UploadResult,
  VersionUpgradeResult,
} from './cleanse-types'
import { listRows, saveRows } from './local-store'
import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

const STORAGE_KEY = 'scraper-config-studio:cleanse-batches'
/** 单次处理行数上限：批次可分多轮跑，中断后从 processedRows 继续。 */
export const CHUNK_SIZE = 50
/** 清洗规则「去重键列」为空时使用的默认键列。 */
const DEFAULT_DEDUP_COLUMN = '手机号'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function emptyState(): CleanseState {
  return { batches: [], uploads: [], keyDomains: [], mappingSnapshots: [], versionHistory: [] }
}

function readState(): CleanseState {
  if (typeof window === 'undefined' || !window.localStorage) {
    return emptyState()
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    return emptyState()
  }
  try {
    const parsed = JSON.parse(raw) as Partial<CleanseState>
    return {
      batches: Array.isArray(parsed.batches) ? parsed.batches : [],
      uploads: Array.isArray(parsed.uploads) ? parsed.uploads : [],
      keyDomains: Array.isArray(parsed.keyDomains) ? parsed.keyDomains : [],
      mappingSnapshots: Array.isArray(parsed.mappingSnapshots) ? parsed.mappingSnapshots : [],
      versionHistory: Array.isArray(parsed.versionHistory) ? parsed.versionHistory : [],
    }
  } catch {
    return emptyState()
  }
}

let cache: CleanseState | null = null

function state(): CleanseState {
  if (cache === null) {
    cache = readState()
  }
  return cache
}

function persist(next: CleanseState): void {
  cache = next
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
}

function nowIso(): string {
  return new Date().toISOString()
}

function nextBatchNo(existing: CleanseBatch[]): string {
  const max = existing.reduce((acc, batch) => {
    const matched = /^BATCH-(\d+)$/.exec(batch.batchNo)
    return matched ? Math.max(acc, Number(matched[1])) : acc
  }, 0)
  return `BATCH-${String(max + 1).padStart(4, '0')}`
}

function findRule(ruleCode: string): EntryRow | undefined {
  return listRows('cleanse').find((row) => String(row['规则编号']) === ruleCode)
}

function splitColumns(value: string): string[] {
  return value
    .split(/[,，、;；|]/)
    .map((item) => item.trim())
    .filter(Boolean)
}

/** 读取规则的当前版本与去重键列；批次一律以这里的结果做快照。 */
export function ruleSnapshot(ruleCode: string): { ruleVersion: string; dedupColumns: string[] } {
  const rule = findRule(ruleCode)
  if (!rule) {
    throw new Error(`没有找到规则编号为 ${ruleCode} 的清洗规则`)
  }
  const version = String(rule['规则版本'] ?? '').trim()
  if (!version) {
    throw new Error(`清洗规则 ${ruleCode} 没有填写规则版本`)
  }
  const configured = splitColumns(String(rule['去重键列'] ?? ''))
  return {
    ruleVersion: version,
    dedupColumns: configured.length > 0 ? configured : [DEFAULT_DEDUP_COLUMN],
  }
}

/** 键域 = 规则 + 去重键列 + 规则版本；新版本另起键域，旧批次不受影响。 */
export function keyDomainId(ruleCode: string, dedupColumns: string[], ruleVersion: string): string {
  const columns = [...dedupColumns].map((item) => item.trim()).sort().join(',')
  return `${ruleCode}@${ruleVersion}#${columns}`
}

function metaOf(batch: CleanseBatch): CleanseBatchMeta {
  const { sourceColumns, sourceRows, keyEntries, results, lastChunk, ...meta } = batch
  void sourceColumns
  void sourceRows
  void keyEntries
  void results
  void lastChunk
  return clone(meta)
}

export function listBatches(): CleanseBatchMeta[] {
  return state().batches.map(metaOf)
}

export function getBatch(id: number): CleanseBatch | null {
  const batch = state().batches.find((item) => item.id === id)
  return batch ? clone(batch) : null
}

export function batchByNo(batchNo: string): CleanseBatch | null {
  const batch = state().batches.find((item) => item.batchNo === batchNo)
  return batch ? clone(batch) : null
}

type CreateInput = {
  ruleCode: string
  sourceName: string
  content: string
  /** 内部播种时允许跳过「已启用」校验 */
  skipStatusCheck?: boolean
}

/**
 * 导入原始记录并建立批次：规则版本、去重键列与键域在此刻固定。
 * 同一份原始记录（同规则 + 同来源摘要 + 同版本）只建一次批次，重复导入直接返回已有批次。
 */
export function createBatch(input: CreateInput): CreateBatchResult {
  const rule = findRule(input.ruleCode)
  if (!rule) {
    return {
      ok: false,
      duplicate: false,
      message: `没有找到规则编号为 ${input.ruleCode} 的清洗规则`,
      batch: null,
    }
  }
  if (!input.skipStatusCheck && String(rule.status) !== '已启用') {
    return {
      ok: false,
      duplicate: false,
      message: `清洗规则 ${input.ruleCode} 当前状态为「${rule.status}」，需要先启用再建批次`,
      batch: null,
    }
  }
  const snapshot = ruleSnapshot(input.ruleCode)
  let parsed
  try {
    parsed = parseDelimited(input.content)
  } catch (error) {
    return {
      ok: false,
      duplicate: false,
      message: error instanceof Error ? error.message : '原始记录解析失败',
      batch: null,
    }
  }
  for (const column of snapshot.dedupColumns) {
    if (!parsed.columns.includes(column)) {
      return {
        ok: false,
        duplicate: false,
        message: `去重键列「${column}」不在原始记录表头中（表头：${parsed.columns.join('、')}）`,
        batch: null,
      }
    }
  }

  const sourceDigest = digestText(`${input.ruleCode}\n${input.content}`)
  const existing = state().batches.find(
    (batch) => batch.sourceDigest === sourceDigest && batch.ruleVersion === snapshot.ruleVersion,
  )
  if (existing) {
    return {
      ok: true,
      duplicate: true,
      message: `同一份原始记录已导入为 ${existing.batchNo}（规则版本 ${existing.ruleVersion}），本次不重复建批次`,
      batch: metaOf(existing),
    }
  }

  const current = state()
  const batchNo = nextBatchNo(current.batches)
  const timestamp = nowIso()
  const batch: CleanseBatch = {
    id: current.batches.reduce((max, item) => Math.max(max, item.id), 0) + 1,
    batchNo,
    ruleId: Number(rule.id),
    ruleCode: input.ruleCode,
    // 版本在这里固定：后续规则升级，本批次仍按旧版本解释字段。
    ruleVersion: snapshot.ruleVersion,
    dedupColumns: snapshot.dedupColumns,
    keyDomainId: keyDomainId(input.ruleCode, snapshot.dedupColumns, snapshot.ruleVersion),
    sourceName: input.sourceName || `${batchNo}.csv`,
    sourceDigest,
    totalRows: parsed.rows.length,
    processedRows: 0,
    keptRows: 0,
    duplicateRows: 0,
    status: '待处理',
    uploadCount: 0,
    lastUploadAt: '',
    createdAt: timestamp,
    updatedAt: timestamp,
    sourceColumns: parsed.columns,
    sourceRows: parsed.rows,
    keyEntries: [],
    results: [],
    lastChunk: null,
  }
  const domainId = batch.keyDomainId
  const domains = current.keyDomains.some((item) => item.id === domainId)
    ? current.keyDomains
    : [
        ...current.keyDomains,
        {
          id: domainId,
          ruleCode: input.ruleCode,
          dedupColumns: snapshot.dedupColumns,
          ruleVersion: snapshot.ruleVersion,
          entries: [],
        } satisfies CleanseKeyDomain,
      ]
  persist({ ...current, keyDomains: domains, batches: [...current.batches, batch] })
  return {
    ok: true,
    duplicate: false,
    message: `${batchNo} 已建立，快照规则版本 ${batch.ruleVersion}，共 ${batch.totalRows} 行，等待处理`,
    batch: metaOf(batch),
  }
}

/**
 * 处理批次：一次最多 CHUNK_SIZE 行，处理完写回游标与键域索引。
 * 中断后再调用会从 processedRows 继续，已处理过的行不会二次进结果。
 */
export function processBatch(id: number, chunkSize = CHUNK_SIZE): ProcessBatchResult {
  const current = state()
  const target = current.batches.find((item) => item.id === id)
  if (!target) {
    return { ok: false, message: `没有找到批次 ${id}`, batch: null, processedNow: 0, done: false }
  }
  if (target.status === '已完成') {
    return {
      ok: true,
      message: `${target.batchNo} 已处理完成，无需重复处理`,
      batch: metaOf(target),
      processedNow: 0,
      done: true,
    }
  }

  const from = target.processedRows
  const remaining = target.sourceRows.slice(from)
  if (remaining.length === 0) {
    const done: CleanseBatch = { ...target, status: '已完成', lastChunk: null, updatedAt: nowIso() }
    persist({ ...current, batches: current.batches.map((item) => (item.id === id ? done : item)) })
    return {
      ok: true,
      message: `${target.batchNo} 没有待处理行，已标记完成`,
      batch: metaOf(done),
      processedNow: 0,
      done: true,
    }
  }

  const domain = current.keyDomains.find((item) => item.id === target.keyDomainId)
  const progress = dedupBatch({
    columns: target.sourceColumns,
    rows: remaining,
    sourceStart: from + 1,
    dedupColumns: target.dedupColumns,
    ruleVersion: target.ruleVersion,
    batchNo: target.batchNo,
    knownKeys: domain?.entries ?? [],
    limit: chunkSize,
  })

  // 结果行号按批次累计，续跑时接在已有结果之后。
  const baseNo = target.results.length
  const appended = progress.outcome.results.map((row) => ({ ...row, resultNo: baseNo + row.resultNo }))
  const processedRows = from + progress.processedNow
  const finished = processedRows >= target.sourceRows.length
  const updated: CleanseBatch = {
    ...target,
    processedRows,
    keptRows: target.keptRows + appended.length,
    duplicateRows: target.duplicateRows + progress.outcome.keyEntries.length,
    status: finished ? '已完成' : '处理中',
    keyEntries: [...target.keyEntries, ...progress.outcome.keyEntries],
    results: [...target.results, ...appended],
    lastChunk: { from: from + 1, to: processedRows },
    updatedAt: nowIso(),
  }
  // 键域只留「键 → 首条来源」，续跑与后续同版本批次都从这里查重。
  const nextDomains = current.keyDomains.map((item) =>
    item.id === target.keyDomainId ? { ...item, entries: progress.outcome.index } : item,
  )
  persist({
    ...current,
    keyDomains: nextDomains,
    batches: current.batches.map((item) => (item.id === id ? updated : item)),
  })
  const scope = finished
    ? '批次已全部处理完成'
    : `已处理到第 ${processedRows}/${target.sourceRows.length} 行，可从批次边界继续`
  return {
    ok: true,
    message: `${target.batchNo} 本轮处理 ${progress.processedNow} 行（${from + 1}-${processedRows}），${scope}`,
    batch: metaOf(updated),
    processedNow: progress.processedNow,
    done: finished,
  }
}

/** 从最近中断的批次继续：没有进行中的批次时返回 null。 */
export function resumePendingBatch(): ProcessBatchResult | null {
  const pending = state().batches.find((batch) => batch.status !== '已完成')
  if (!pending) {
    return null
  }
  return processBatch(pending.id)
}

/** 把未完成批次一次跑到完成，返回每轮结果。 */
export function processBatchToEnd(id: number, chunkSize = CHUNK_SIZE): ProcessBatchResult[] {
  const results: ProcessBatchResult[] = []
  for (let guard = 0; guard < 10000; guard += 1) {
    const step = processBatch(id, chunkSize)
    results.push(step)
    if (!step.ok || step.done) {
      break
    }
  }
  return results
}

export function exportKeyTable(id: number): { filename: string; content: string } | null {
  const batch = getBatch(id)
  if (!batch) {
    return null
  }
  const columns = ['来源行号', '去重键', '首条行号', '首条批次', '规则版本']
  const rows = batch.keyEntries.map((entry) => [
    entry.sourceRow,
    entry.key,
    entry.duplicateOf,
    entry.duplicateOfBatch,
    entry.ruleVersion,
  ])
  return { filename: `${batch.batchNo}-键表.csv`, content: toCsv(columns, rows) }
}

export function exportResult(id: number): { filename: string; content: string } | null {
  const batch = getBatch(id)
  if (!batch) {
    return null
  }
  const columns = ['结果行号', '来源行号', '去重键', ...batch.sourceColumns]
  const rows = batch.results.map((row) => [
    row.resultNo,
    row.sourceRow,
    row.key,
    ...batch.sourceColumns.map((column) => row.values[column] ?? ''),
  ])
  return { filename: `${batch.batchNo}-清洗结果.csv`, content: toCsv(columns, rows) }
}

/**
 * 上传清洗结果文件：必须与批次预期结果逐行对齐。
 * 同一文件（内容摘要相同）重复上传只记一次，不会重复生效。
 */
export function uploadResult(id: number, filename: string, content: string): UploadResult {
  const current = state()
  const batch = current.batches.find((item) => item.id === id)
  if (!batch) {
    return { ok: false, duplicate: false, message: `没有找到批次 ${id}`, upload: null }
  }
  if (batch.status !== '已完成') {
    return {
      ok: false,
      duplicate: false,
      message: `${batch.batchNo} 还没处理完（${batch.processedRows}/${batch.totalRows}），请先处理批次`,
      upload: null,
    }
  }
  let parsed
  try {
    parsed = parseDelimited(content)
  } catch (error) {
    return {
      ok: false,
      duplicate: false,
      message: error instanceof Error ? error.message : '结果文件解析失败',
      upload: null,
    }
  }

  const digest = digestText(content)
  const prior = current.uploads.find((item) => item.batchId === id && item.digest === digest)
  if (prior) {
    return {
      ok: true,
      duplicate: true,
      message: `该结果文件已于 ${prior.importedAt} 导入过，本次不重复生效`,
      upload: clone(prior),
    }
  }

  const expectedKeys = batch.results.map((row) => `${row.resultNo}:${row.sourceRow}`)
  const actualKeys = parsed.rows.map((cells) => {
    const resultNo = (cells[0] ?? '').trim()
    const sourceRow = (cells[1] ?? '').trim()
    return `${resultNo}:${sourceRow}`
  })
  const matchedRows = expectedKeys.filter((key, index) => actualKeys[index] === key).length
  const consistent = parsed.rows.length === expectedKeys.length && matchedRows === expectedKeys.length

  const upload: CleanseUploadRecord = {
    batchId: id,
    batchNo: batch.batchNo,
    digest,
    filename,
    rowCount: parsed.rows.length,
    expectedRows: batch.results.length,
    matchedRows,
    consistent,
    importedAt: nowIso(),
  }
  const updated: CleanseBatch = {
    ...batch,
    uploadCount: batch.uploadCount + 1,
    lastUploadAt: upload.importedAt,
    updatedAt: upload.importedAt,
  }
  persist({
    ...current,
    batches: current.batches.map((item) => (item.id === id ? updated : item)),
    uploads: [...current.uploads, upload],
  })
  if (!consistent) {
    return {
      ok: false,
      duplicate: false,
      message: `结果文件与批次不一致：期望 ${batch.results.length} 行，实际 ${parsed.rows.length} 行，行号对齐 ${matchedRows} 行`,
      upload,
    }
  }
  return {
    ok: true,
    duplicate: false,
    message: `结果文件已导入 ${batch.batchNo}，${upload.rowCount} 行与结果逐行对齐`,
    upload,
  }
}

export function listUploads(batchId?: number): CleanseUploadRecord[] {
  const uploads = state().uploads
  return clone(batchId === undefined ? uploads : uploads.filter((item) => item.batchId === batchId))
}

/**
 * 字段映射清单同步清洗版本：先快照旧版本映射，再改写映射版本字段。
 * 历史结果按快照版本读取，不依赖映射表当前内容。
 */
export function syncMappingVersion(ruleCode: string, newVersion: string): VersionUpgradeResult {
  const rule = findRule(ruleCode)
  if (!rule) {
    return {
      ok: false,
      message: `没有找到规则编号为 ${ruleCode} 的清洗规则`,
      fromVersion: '',
      toVersion: newVersion,
      syncedMappings: 0,
    }
  }
  const fromVersion = String(rule['规则版本'] ?? '').trim()
  if (!fromVersion) {
    return {
      ok: false,
      message: `清洗规则 ${ruleCode} 没有填写规则版本`,
      fromVersion: '',
      toVersion: newVersion,
      syncedMappings: 0,
    }
  }
  if (fromVersion === newVersion) {
    return {
      ok: false,
      message: `清洗规则 ${ruleCode} 已经是版本 ${newVersion}`,
      fromVersion,
      toVersion: newVersion,
      syncedMappings: 0,
    }
  }

  const current = state()
  const snapshot: MappingSnapshot = {
    ruleCode,
    version: fromVersion,
    capturedAt: nowIso(),
    rows: clone(listRows('extractor')),
  }

  // 旧批次保持各自快照版本；这里只推进规则与映射清单的当前版本。
  const cleanseRows = listRows('cleanse').map((row) =>
    String(row['规则编号']) === ruleCode ? { ...row, ['规则版本']: newVersion } : row,
  )
  saveRows('cleanse', cleanseRows)

  const extractorRows = listRows('extractor').map((row) => ({
    ...row,
    ['清洗版本']: newVersion,
    ['映射版本说明']: `对齐 ${ruleCode}@${newVersion}`,
  }))
  saveRows('extractor', extractorRows)

  const change = {
    ruleCode,
    fromVersion,
    toVersion: newVersion,
    changedAt: snapshot.capturedAt,
    syncedMappings: extractorRows.length,
  }
  persist({
    ...current,
    mappingSnapshots: [...current.mappingSnapshots, snapshot],
    versionHistory: [...current.versionHistory, change],
  })
  return {
    ok: true,
    message: `清洗规则 ${ruleCode} 由 ${fromVersion} 升到 ${newVersion}，字段映射已同步 ${extractorRows.length} 条；旧版本映射快照已留存，历史结果仍可读`,
    fromVersion,
    toVersion: newVersion,
    syncedMappings: extractorRows.length,
  }
}

/** 历史映射快照：按版本读取，不要求映射表当前仍保留旧字段。 */
export function mappingSnapshot(ruleCode: string, version: string): MappingSnapshot | null {
  const snapshot = state().mappingSnapshots.find(
    (item) => item.ruleCode === ruleCode && item.version === version,
  )
  return snapshot ? clone(snapshot) : null
}

export function listVersionHistory(): CleanseState['versionHistory'] {
  return clone(state().versionHistory)
}

/** 页面重置用：清空批次、上传记录、键域与版本快照。 */
export function resetCleanseState(): void {
  persist(emptyState())
}

/* ------------------------------------------------------------------ */
/* 基线迁移与示例批次                                                    */
/* ------------------------------------------------------------------ */

const SAMPLE_RULE = 'CLEA-74'
const SAMPLE_BATCH_1 = [
  ['姓名', '手机号', '城市'],
  ['张三', '13800001111', '北京'],
  ['李四', '13700003333', '上海'],
  ['王五', '13900002222', '广州'],
  ['赵六', '13600004444', '深圳'],
  ['钱七', '13500005555', '杭州'],
].map((row) => row.join(',')).join('\n')

const SAMPLE_BATCH_2 = [
  ['姓名', '手机号', '城市'],
  ['孙八', '13400006666', '成都'],
  ['周九', '13800001111', '北京'],
  ['吴十', '13300007777', '武汉'],
  ['郑一', '13800001111', '北京'],
  ['王二', '13200008888', '西安'],
  ['冯三', '13100009999', '南京'],
  ['陈四', '13900002222', '广州'],
].map((row) => row.join(',')).join('\n')

/**
 * 老数据迁移：补齐 CLEA-74 规则，并让字段映射清单带上清洗版本。
 * 只补缺失项，不覆盖已有规则或映射内容，重复调用无副作用。
 */
export function ensureCleanseBaseline(): void {
  const rules = listRows('cleanse')
  let nextRules = rules
  if (!rules.some((row) => String(row['规则编号']) === SAMPLE_RULE)) {
    const template = SEED_ROWS['cleanse']?.find((row) => String(row['规则编号']) === SAMPLE_RULE)
    if (template) {
      const maxId = rules.reduce((max, row) => Math.max(max, Number(row.id)), 0)
      nextRules = [...rules, { ...clone(template), id: maxId + 1 }]
      saveRows('cleanse', nextRules)
    }
  }
  const baselineRule = nextRules.find((row) => String(row['规则编号']) === SAMPLE_RULE)
  const currentVersion = String(baselineRule?.['规则版本'] ?? '').trim()

  const mappings = listRows('extractor')
  if (mappings.length > 0) {
    const needsVersion = mappings.some((row) => !String(row['清洗版本'] ?? '').trim())
    if (needsVersion) {
      saveRows(
        'extractor',
        mappings.map((row) =>
          String(row['清洗版本'] ?? '').trim()
            ? row
            : {
                ...row,
                ['清洗版本']: currentVersion,
                ['映射版本说明']: currentVersion ? `对齐 ${SAMPLE_RULE}@${currentVersion}` : '待同步清洗版本',
              },
        ),
      )
    }
  }
}

/** 首次打开清洗页时播种两批样本；已有批次时不动。 */export function ensureSampleBatches(): void {
  ensureCleanseBaseline()
  if (state().batches.length > 0) {
    return
  }
  if (!findRule(SAMPLE_RULE)) {
    return
  }
  const first = createBatch({
    ruleCode: SAMPLE_RULE,
    sourceName: '第一批原始记录.csv',
    content: SAMPLE_BATCH_1,
    skipStatusCheck: true,
  })
  if (first.ok && first.batch) {
    processBatchToEnd(first.batch.id)
  }
  const second = createBatch({
    ruleCode: SAMPLE_RULE,
    sourceName: '第二批原始记录.csv',
    content: SAMPLE_BATCH_2,
    skipStatusCheck: true,
  })
  if (second.ok && second.batch) {
    processBatchToEnd(second.batch.id)
  }
}

/** 样例批次号便于测试与页面直接定位。 */
export function sampleBatchNos(): { first: string; second: string } {
  return { first: 'BATCH-0001', second: 'BATCH-0002' }
}
