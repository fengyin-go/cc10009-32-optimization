<template>
  <section class="page" data-module="cleanse">
    <header class="page-head">
      <div>
        <h2>数据清洗管理</h2>
        <p class="page-desc">维护清洗规则，按批次导入原始记录、去重并上传清洗结果；规则版本在批次创建时快照，旧批次沿用原版本。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记清洗规则</button>
        <button class="btn" type="button" @click="exportRows">导出数据清洗清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无数据清洗数据，可先登记清洗规则</td>
        </tr>
      </tbody>
    </table>

    <section class="panel">
      <header class="panel-head">
        <h3>清洗批次</h3>
        <div class="panel-actions">
          <label class="file-pick">
            <input type="file" accept=".csv,.tsv,.txt" @change="onSourcePicked" />
            <span>导入原始记录</span>
          </label>
          <button class="btn" type="button" :disabled="!pendingBatch" @click="resume">从批次边界继续</button>
        </div>
      </header>

      <form class="filter-bar" @submit.prevent="importSource">
        <label class="filter-item">
          <span>清洗规则</span>
          <select v-model="importRule">
            <option v-for="rule in ruleOptions" :key="rule.code" :value="rule.code">
              {{ rule.code }} · {{ rule.version }}
            </option>
          </select>
        </label>
        <label class="filter-item">
          <span>来源名称</span>
          <input v-model="sourceName" placeholder="例如 第二批原始记录.csv" />
        </label>
        <button class="btn primary" type="submit" :disabled="!importRule">建立批次</button>
        <span v-if="sourceText" class="hint">已读取 {{ sourceText.length }} 字符</span>
      </form>

      <p v-if="banner" class="banner" :class="{ error: bannerError }">{{ banner }}</p>

      <table class="data-table">
        <thead>
          <tr>
            <th>批次号</th><th>规则</th><th>规则版本</th><th>去重键列</th><th>处理进度</th>
            <th>保留 / 重复</th><th>状态</th><th>上游结果</th><th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="batch in batches" :key="batch.id">
            <td>{{ batch.batchNo }}</td>
            <td>{{ batch.ruleCode }}</td>
            <td>{{ batch.ruleVersion }}</td>
            <td>{{ batch.dedupColumns.join('、') }}</td>
            <td>{{ batch.processedRows }} / {{ batch.totalRows }}</td>
            <td>{{ batch.keptRows }} / {{ batch.duplicateRows }}</td>
            <td>{{ batch.status }}</td>
            <td>{{ batch.uploadCount }} 次<template v-if="batch.lastUploadAt">（{{ batch.lastUploadAt }}）</template></td>
            <td class="row-actions">
              <button class="link" type="button" @click="step(batch.id)">处理</button>
              <button class="link" type="button" @click="inspect(batch.id)">键表</button>
              <button class="link" type="button" @click="downloadKeyTable(batch.id)">导出键表</button>
              <button class="link" type="button" @click="downloadResult(batch.id)">导出结果</button>
              <label class="link file-link">
                <input type="file" accept=".csv,.tsv,.txt" @change="(event) => onResultPicked(event, batch.id)" />
                上传结果
              </label>
            </td>
          </tr>
          <tr v-if="!batches.length">
            <td colspan="9" class="empty-state">还没有批次，先导入一份原始记录</td>
          </tr>
        </tbody>
      </table>
    </section>

    <section v-if="selected" class="panel">
      <header class="panel-head">
        <h3>{{ selected.batchNo }} 键表（规则版本 {{ selected.ruleVersion }}）</h3>
        <span class="hint">相同键只删除后续重复，首条保留</span>
      </header>
      <table class="data-table">
        <thead>
          <tr><th>来源行号</th><th>去重键</th><th>首条行号</th><th>首条批次</th><th>规则版本</th><th>结果行号</th></tr>
        </thead>
        <tbody>
          <tr v-for="entry in selected.keyEntries" :key="`${entry.sourceRow}-${entry.key}`">
            <td>{{ entry.sourceRow }}</td>
            <td>{{ entry.key }}</td>
            <td>{{ entry.duplicateOf }}</td>
            <td>{{ entry.duplicateOfBatch }}</td>
            <td>{{ entry.ruleVersion }}</td>
            <td>{{ resultNoOf(entry.sourceRow) }}</td>
          </tr>
          <tr v-if="!selected.keyEntries.length">
            <td colspan="6" class="empty-state">本批次没有后续重复行</td>
          </tr>
        </tbody>
      </table>
      <p class="hint">
        保留 {{ selected.results.length }} 行；被删除 {{ selected.keyEntries.length }} 行；结果来源行号：
        {{ selected.results.map((row) => row.sourceRow).join('、') || '—' }}
      </p>
    </section>

    <section class="panel">
      <header class="panel-head">
        <h3>版本同步</h3>
        <span class="hint">同步到字段映射清单，旧版本映射快照留存，历史结果仍可读</span>
      </header>
      <form class="filter-bar" @submit.prevent="upgrade">
        <label class="filter-item">
          <span>清洗规则</span>
          <select v-model="upgradeRule">
            <option v-for="rule in ruleOptions" :key="rule.code" :value="rule.code">{{ rule.code }}</option>
          </select>
        </label>
        <label class="filter-item">
          <span>新版本号</span>
          <input v-model="newVersion" placeholder="例如 CLEA-75" />
        </label>
        <button class="btn primary" type="submit">同步到字段映射</button>
        <span v-if="currentVersion" class="hint">当前版本 {{ currentVersion }}</span>
      </form>
      <table v-if="versionHistory.length" class="data-table">
        <thead><tr><th>规则</th><th>原版本</th><th>新版本</th><th>变更时间</th><th>同步映射条数</th></tr></thead>
        <tbody>
          <tr v-for="item in versionHistory" :key="`${item.ruleCode}-${item.changedAt}`">
            <td>{{ item.ruleCode }}</td>
            <td>{{ item.fromVersion }}</td>
            <td>{{ item.toVersion }}</td>
            <td>{{ item.changedAt }}</td>
            <td>{{ item.syncedMappings }}</td>
          </tr>
        </tbody>
      </table>
    </section>

    <footer class="page-foot">
      <span>共 {{ total }} 条数据清洗记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  downloadText,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import {
  createBatch,
  ensureSampleBatches,
  exportKeyTable,
  exportResult,
  getBatch,
  listBatches,
  listVersionHistory,
  processBatch,
  resumePendingBatch,
  syncMappingVersion,
  uploadResult,
} from '@/data/cleanse-service'
import type { CleanseBatch, CleanseBatchMeta } from '@/data/cleanse-types'
import type { EntryRow } from '@/data/types'
const meta = moduleMeta('cleanse')
const columns = ["规则编号", "目标字段", "空值替换", "格式规范化", "异常值剔除", "去重键列", "规则版本", "生效日期"]
const actions = ["提交校验", "启用规则", "停用规则"]
const statuses = ["草稿", "待校验", "已启用", "已停用"]
const stats = [{"label": "清洗规则总数", "value": 0}, {"label": "已启用规则", "value": 0}, {"label": "待校验规则", "value": 0}]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

const batches = ref<CleanseBatchMeta[]>([])
const selected = ref<CleanseBatch | null>(null)
const banner = ref('')
const bannerError = ref(false)
const importRule = ref('')
const sourceName = ref('')
const sourceText = ref('')
const upgradeRule = ref('')
const newVersion = ref('')
const versionHistory = ref<ReturnType<typeof listVersionHistory>>([])

const ruleOptions = computed(() =>
  rows.value.map((row) => ({
    code: String(row['规则编号']),
    version: String(row['规则版本'] ?? ''),
    status: String(row.status),
  })),
)
const pendingBatch = computed(() => batches.value.find((batch) => batch.status !== '已完成') ?? null)
const currentVersion = computed(() => {
  const rule = ruleOptions.value.find((item) => item.code === upgradeRule.value)
  return rule ? rule.version : ''
})

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '清洗规则登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function showBanner(message: string, error = false) {
  banner.value = message
  bannerError.value = error
}

function reloadBatches() {
  batches.value = listBatches()
  if (selected.value) {
    selected.value = getBatch(selected.value.id)
  }
  versionHistory.value = listVersionHistory()
}

async function readFile(file: File): Promise<string> {
  return await file.text()
}

async function onSourcePicked(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) {
    return
  }
  sourceText.value = await readFile(file)
  sourceName.value = file.name
  input.value = ''
}

async function importSource() {
  if (!importRule.value) {
    showBanner('先选择一条清洗规则', true)
    return
  }
  if (!sourceText.value) {
    showBanner('先导入一份原始记录文件', true)
    return
  }
  const result = createBatch({
    ruleCode: importRule.value,
    sourceName: sourceName.value,
    content: sourceText.value,
  })
  showBanner(result.message, !result.ok)
  if (result.ok && result.batch) {
    // 建批次后立即跑一轮，中断时留在批次边界。
    const step = processBatch(result.batch.id)
    showBanner(result.message + '；' + step.message, !step.ok)
    sourceText.value = ''
    sourceName.value = ''
    inspect(result.batch.id)
  }
  reloadBatches()
}

function step(id: number) {
  const result = processBatch(id)
  showBanner(result.message, !result.ok)
  if (selected.value?.id === id) {
    selected.value = getBatch(id)
  }
  reloadBatches()
}

function resume() {
  const result = resumePendingBatch()
  if (!result) {
    showBanner('没有待继续的批次')
    return
  }
  showBanner(result.message, !result.ok)
  reloadBatches()
}

function inspect(id: number) {
  selected.value = getBatch(id)
}

function resultNoOf(sourceRow: number): string {
  const row = selected.value?.results.find((item) => item.sourceRow === sourceRow)
  return row ? String(row.resultNo) : '已删除'
}

function downloadKeyTable(id: number) {
  const payload = exportKeyTable(id)
  if (!payload) {
    showBanner('没有找到该批次的键表', true)
    return
  }
  downloadText(payload.filename, payload.content)
}

function downloadResult(id: number) {
  const payload = exportResult(id)
  if (!payload) {
    showBanner('没有找到该批次的结果', true)
    return
  }
  downloadText(payload.filename, payload.content)
}

async function onResultPicked(event: Event, id: number) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) {
    return
  }
  const content = await readFile(file)
  const result = uploadResult(id, file.name, content)
  showBanner(result.message, !result.ok)
  input.value = ''
  reloadBatches()
}

function upgrade() {
  if (!upgradeRule.value || !newVersion.value.trim()) {
    showBanner('先选择规则并填写新版本号', true)
    return
  }
  const result = syncMappingVersion(upgradeRule.value, newVersion.value.trim())
  showBanner(result.message, !result.ok)
  if (result.ok) {
    newVersion.value = ''
    reload()
  }
  reloadBatches()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    const preferred = ruleOptions.value.find((rule) => rule.code === 'CLEA-74')
    if (!importRule.value && ruleOptions.value.length > 0) {
      importRule.value = preferred?.code ?? (ruleOptions.value.find((rule) => rule.status === '已启用') ?? ruleOptions.value[0]).code
    }
    if (!upgradeRule.value && ruleOptions.value.length > 0) {
      upgradeRule.value = preferred?.code ?? ruleOptions.value[0].code
    }
    reloadBatches()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '数据清洗列表读取失败'
  }
}

onMounted(() => {
  reload()
  ensureSampleBatches()
  reloadBatches()
})
</script>
