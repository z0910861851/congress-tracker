// sync.js — 國會交易資料同步腳本
import { createClient } from '@supabase/supabase-js'
import fetch from 'node-fetch'

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) { console.error('❌ 缺少環境變數'); process.exit(1) }
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

const DATA_SOURCES = [
  {
    name: 'House Stock Watcher S3',
    url: 'https://house-stock-watcher-data.s3-us-west-2.amazonaws.com/data/all_transactions.json',
    parse: (data) => Array.isArray(data) ? data : [],
  },
  {
    name: 'Senate Stock Watcher GitHub',
    url: 'https://raw.githubusercontent.com/timothycarambat/senate-stock-watcher-data/master/aggregate/all_transactions.json',
    parse: (data) => Array.isArray(data) ? data : [],
  },
]

async function fetchTrades() {
  for (const source of DATA_SOURCES) {
    console.log(`📡 嘗試：${source.name}`)
    try {
      const res = await fetch(source.url, { headers: { 'User-Agent': 'congress-tracker-bot/1.0' } })
      if (!res.ok) { console.warn(`  ⚠️ HTTP ${res.status}`); continue }
      const raw = await res.json()
      const trades = source.parse(raw)
      if (trades.length === 0) { console.warn('  ⚠️ 資料為空'); continue }
      console.log(`  ✅ 取得 ${trades.length.toLocaleString()} 筆`)
      return { trades, sourceName: source.name }
    } catch (err) {
      console.warn(`  ❌ ${err.message}`)
    }
  }
  throw new Error('所有資料來源均失敗')
}

function normalizeTrade(raw) {
  // House 格式：representative | Senate 格式：senator | 通用：name
  const rep = raw.representative || raw.senator || raw.name || null
  if (!rep) return null
  const parts = [
    rep.toLowerCase().replace(/\s+/g,'_'),
    raw.transaction_date || 'nodate',
    (raw.ticker || raw.asset_description || 'noticker').toLowerCase().replace(/[^a-z0-9]/g,'_').slice(0,20),
    (raw.type || 'notype').toLowerCase().replace(/[^a-z]/g,'').slice(0,10),
  ]
  return {
    id: parts.join('__').replace(/[^a-z0-9_]/g,'').slice(0,200),
    disclosure_date: raw.disclosure_date || raw.date_recieved || null,
    transaction_date: raw.transaction_date || null,
    representative: rep,
    district: raw.district || null,
    ticker: raw.ticker && raw.ticker !== '--' ? raw.ticker.toUpperCase() : null,
    asset_description: (raw.asset_description || '').slice(0,200) || null,
    trade_type: raw.type || null,
    amount: raw.amount || null,
    party: raw.party || null,
    state: raw.state || null,
    owner: raw.owner || null,
  }
}

const BATCH_SIZE = 500
async function syncToSupabase(trades) {
  const normalized = trades.map(normalizeTrade).filter(t => t && t.id && t.representative)
  console.log(`📊 正規化後：${normalized.length.toLocaleString()} 筆`)
  if (normalized.length === 0) { console.log('⚠️ 無有效資料'); return 0 }
  let inserted = 0
  for (let i = 0; i < normalized.length; i += BATCH_SIZE) {
    const { error } = await supabase.from('congress_trades').upsert(normalized.slice(i, i + BATCH_SIZE), { onConflict: 'id', ignoreDuplicates: true })
    if (error) { console.error('Supabase error:', error.message); throw error }
    inserted += Math.min(BATCH_SIZE, normalized.length - i)
    process.stdout.write(`\r   進度：${inserted.toLocaleString()} / ${normalized.length.toLocaleString()}`)
  }
  console.log(`\n   ✅ 完成！`)
  return inserted
}

async function main() {
  console.log('🚀 開始同步')
  try {
    const { trades, sourceName } = await fetchTrades()
    const inserted = await syncToSupabase(trades)
    await supabase.from('sync_meta').upsert({ id: 'latest', last_synced_at: new Date().toISOString(), total_trades: inserted, source: sourceName })
    console.log(`\n✅ 完成！來源：${sourceName}，寫入：${inserted.toLocaleString()} 筆`)
  } catch (err) {
    console.error('\n❌ 失敗：', err.message)
    process.exit(1)
  }
}
main()
