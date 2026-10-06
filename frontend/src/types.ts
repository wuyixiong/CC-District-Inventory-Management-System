export interface BatchView {
  location: string
  product: string // 产品图号
  batch: string // 批次号（可为空）
  qty: number
  since: string
  days: number
  state: 'ok' | 'yellow' | 'red'
}

export interface LocationView {
  code: string
  zone: string
  note: string
  registered: boolean
  enabled: boolean
  batches: number
  qty: number
  maxDays: number
  state: 'empty' | 'ok' | 'yellow' | 'red'
  items: BatchView[]
}

export interface Board {
  asOf: string
  lastAt: string
  recorder: string
  seq: number
  totals: { locations: number; batches: number; qty: number; overage: number }
  locations: LocationView[]
  overageList: BatchView[]
}

export interface Settings {
  yellowDays: number
  redDays: number
}

export interface LocationItem {
  code: string
  zone: string
  note: string
  enabled: boolean
}

export interface StateResp {
  empty: boolean
  settings: Settings
  board?: Board
}

export interface AuditEvent {
  seq: number
  date: string
  at: string
  recorder: string
  type: string
  summary: string
}

export interface DingtalkConfig {
  appKey: string
  appSecret: string
  operatorId: string
  baseId: string
  sheet: string
  autoSyncMinutes: number
  mirror: boolean
  corpId: string
  agentId: string
  lockRecorder: boolean
}

export interface DingtalkStatus {
  configured: boolean
  missing: string[]
  config: DingtalkConfig
  status: { lastSyncAt: string; total: number; added: number; totalAdded: number; skippedCount: number; lastError: string }
}

export interface SyncReport {
  at: string
  total: number
  added: number
  skippedRows: { id: string; reason: string }[]
}
