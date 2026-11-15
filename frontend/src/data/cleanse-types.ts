/** 数据清洗批次：规则版本快照、去重键表、结果文件与中断游标的持久化结构。
 *
 * 三条边界：
 * - 规则边界：`cleanse` 模块的一行就是一条清洗规则，批次创建时从这里快照版本与去重键列。
 * - 批次边界：去重键集合按「规则 + 规则版本 + 去重键列」分域，逐批增量装载，只保键不保整行。
 * - 映射边界：字段映射清单跟随当前版本，旧版本整体快照留存，历史结果按快照版本读取。
 */

/** 单条清洗结果：只保留去重后留下的行，并记录其来源行号。 */
export type CleanseResultRow = {
  /** 清洗结果中的行号（从 1 开始，只统计保留下来的行） */
  resultNo: number
  /** 原始记录中的行号（从 1 开始，不含表头） */
  sourceRow: number
  /** 去重键（按批次快照里的去重键列拼成；空键行为空串） */
  key: string
  values: Record<string, string>
}

/** 键表一行：只记被删除的后续重复行，首条保留行留在结果里。 */
export type CleanseKeyEntry = {
  sourceRow: number
  key: string
  /** 同键首次出现的来源行号（同键域内，可能来自更早的批次） */
  duplicateOf: number
  /** 同键首次出现所在批次号 */
  duplicateOfBatch: string
  /** 判定该行重复时使用的规则版本（批次快照，不随规则后续升级变化） */
  ruleVersion: string
}

/** 键域索引条目：只保留键与首条来源，不保留整行。 */
export type CleanseKeyIndexEntry = {
  key: string
  sourceRow: number
  batchNo: string
  ruleVersion: string
}

/** 去重键域：同一规则 + 同一组去重键列 + 同一规则版本共用一个键域。 */
export type CleanseKeyDomain = {
  id: string
  ruleCode: string
  dedupColumns: string[]
  ruleVersion: string
  entries: CleanseKeyIndexEntry[]
}

export type CleanseBatchStatus = '待处理' | '处理中' | '已完成'

export type CleanseUploadRecord = {
  batchId: number
  batchNo: string
  digest: string
  filename: string
  rowCount: number
  expectedRows: number
  matchedRows: number
  consistent: boolean
  importedAt: string
}

export type CleanseBatchMeta = {
  id: number
  batchNo: string
  ruleId: number
  ruleCode: string
  /** 创建批次时从清洗规则快照下来的版本号；之后升级规则不影响本批次 */
  ruleVersion: string
  dedupColumns: string[]
  keyDomainId: string
  sourceName: string
  /** 原始记录内容摘要，用于阻止同一份原始记录重复导入 */
  sourceDigest: string
  totalRows: number
  /** 已处理到的原始行游标；中断后从这里继续 */
  processedRows: number
  keptRows: number
  duplicateRows: number
  status: CleanseBatchStatus
  uploadCount: number
  lastUploadAt: string
  createdAt: string
  updatedAt: string
}

export type CleanseBatch = CleanseBatchMeta & {
  sourceColumns: string[]
  sourceRows: string[][]
  /** 键表只含当前批次的重复行，不含全量历史键 */
  keyEntries: CleanseKeyEntry[]
  results: CleanseResultRow[]
  /** 最近一次处理的原始行区间，便于核对批次边界 */
  lastChunk: { from: number; to: number } | null
}

export type MappingSnapshot = {
  ruleCode: string
  /** 快照对应的清洗版本；历史结果按这一版映射保持可读 */
  version: string
  capturedAt: string
  rows: Record<string, string | number | boolean>[]
}

export type VersionChange = {
  ruleCode: string
  fromVersion: string
  toVersion: string
  changedAt: string
  syncedMappings: number
}

export type CleanseState = {
  batches: CleanseBatch[]
  uploads: CleanseUploadRecord[]
  keyDomains: CleanseKeyDomain[]
  mappingSnapshots: MappingSnapshot[]
  versionHistory: VersionChange[]
}

export type CreateBatchResult = {
  ok: boolean
  duplicate: boolean
  message: string
  batch: CleanseBatchMeta | null
}

export type ProcessBatchResult = {
  ok: boolean
  message: string
  batch: CleanseBatchMeta | null
  processedNow: number
  done: boolean
}

export type UploadResult = {
  ok: boolean
  duplicate: boolean
  message: string
  upload: CleanseUploadRecord | null
}

export type VersionUpgradeResult = {
  ok: boolean
  message: string
  fromVersion: string
  toVersion: string
  syncedMappings: number
}
