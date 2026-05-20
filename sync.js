// sync.js — 國會交易資料同步腳本
// 每天由 GitHub Actions 執行

import { createClient } from '@supabase/supabase-js'
import fetch from 'node-fetch'

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('❌ 缺少環境變數：SUPABASE_URL 或 SUPABASE_SERVICE_KEY')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

const DATA_SOURCES = [
  {
    name: 'House Stock Watcher S3',
    url: 'https://house-stock-watcher-data.s3-us-west-2.amazonaws.com/data/all_transactions.json',
    parse: (data) => data,
  },
  {
    name: 'Senate Stock Watcher GitHub',
    url: 'https://raw.githubusercontent.com/timothycarambat/senate-stock-watcher-data/master/aggregate/all_transactions.json',
    parse: (data) => data,
  },
]

async function fetchTrades() {
  for (const source of DATA_SOURCES) {
    console.log(`📡 嘗試資料來源：${source.name}`)
    try {
      const res = await fetch(source.url, {
        headers: { 'User-Agent': 'congress-tracker-bot/1.0' },
        timeout: 30000,
      })
      if (!res.ok) { console.warn(`  ⚠️ HTTP ${res.status}`); continue }
      const raw = await res.json()
      const trades = source.parse(raw)
      if (!Array.isArray(trades) || trades.length === 0) continue
      console.log(`  ✅ 成功取得 ${trades.length.toLocaleString()} 筆`)
      return { trades, sourceName: source.name }
    } catch (err) {
      console.warn(`  ❌ 錯誤：${err.message}`)
    }
  }
  throw new Error('所有資料來源均失敗')
}

function normalizeTradeId(trade) {
  const parts = [
    (trade.representative || 'unknown').toLowerCase().replace(/\s+/g, '_'),
    trade.transaction_date || 'nodate',
    (trade.ticker || trade.asset_description || 'noticker').toLowerCase().replace(/\s+/g, '_').slice(0, 20),
    (trade.type || 'notype').toLowerCase().slice(0, 10),
  ]
  return parts.join('__').replace(/[^a-z0-9_]/g, '')
}

function normalizeTrade(raw) {
  return {
    id: normalizeTradeId(raw),
    disclosure_date: raw.disclosure_date || null,
    transaction_date: raw.transaction_date || null,
    representative: raw.representative || raw.name || null,
    district: raw.district || null,
    ticker: raw.ticker && raw.ticker !== '--' ? raw.ticker.toUpperCase() : null,
    asset_description: (raw.asset_description || '').slice(0, 200) || null,
    trade_type: raw.type || null,
    amount: raw.amount || null,
    party: raw.party || null,
    state: raw.state || null,
    owner: raw.owner || null,
  }
}

const BATCH_SIZE = 500

async function upsertBatch(trades) {
  const { error } = await supabase.from('congress_trades').upsert(trades, { onConflict: 'id', ignoreDuplicates: true })
  if (error) throw error
}

async function syncToSupabase(trades) {
Add sync.js  const normalized = trades.map(normalizeTrade).filter(t => t.id && t.representative)
  let inserted = 0
  for (let i = 0; i < normalized.length; i += BATCH_SIZE) {
    await upsertBatch(normalized.slice(i, i + BATCH_SIZE))
    inserted += Math.min(BATCH_SIZE, normalized.length - i)
    process.stdout.write(`\r   進度：${inserted.toLocaleString()} / ${normalized.length.toLocaleString()}`)
  }
  console.log(`\n   ✅ 完成！`)
  return inserted
}

async function main() {
  console.log('🚀 開始同步國會交易資料')
  try {
    const { trades, sourceName } = await fetchTrades()
    const inserted = await syncToSupabase(trades)
    await supabase.from('sync_meta').upsert({ id: 'latest', last_synced_at: new Date().toISOString(), total_trades: inserted, source: sourceName })
    console.log(`\n✅ 同步完成！來源：${sourceName}，寫入：${inserted.toLocaleString()} 筆`)
  } catch (err) {
    console.error('\n❌ 同步失敗：', err.message)
    process.exit(1)
  }
}

main()
