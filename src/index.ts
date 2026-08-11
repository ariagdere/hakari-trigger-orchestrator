import express, { Request, Response } from 'express'

const app = express()
app.use(express.json({ limit: '20mb' }))

// ─── ENV ────────────────────────────────────────────────────────────────────
const APIFY_ACT_ID       = process.env.APIFY_ACT_ID!
const APIFY_TOKEN        = process.env.APIFY_TOKEN!
const ROBOT_1_ID         = process.env.ROBOT_1_ID!
const ROBOT_2_ID         = process.env.ROBOT_2_ID!
const ROBOT_1_ORIGIN_URL = process.env.ROBOT_1_ORIGIN_URL!
const ROBOT_2_ORIGIN_URL = process.env.ROBOT_2_ORIGIN_URL!
const BROWSEAI_API_KEY   = process.env.BROWSEAI_API_KEY!
const MAKE_AI_WEBHOOK_URL    = process.env.MAKE_AI_WEBHOOK_URL!     // mevcut, DEĞİŞMEYEN payload formatı
const MAKE_NAIF_WEBHOOK_URL  = process.env.MAKE_NAIF_WEBHOOK_URL!   // yeni, hızlı yol
const MAKE_ERROR_WEBHOOK_URL = process.env.MAKE_ERROR_WEBHOOK_URL!
const PUBLIC_BASE_URL     = process.env.PUBLIC_BASE_URL!            // bu servisin kendi public URL'i (Apify dynamic webhook için)
const PORT                = process.env.PORT || 3000

const REQUIRED_ENV = [
  'APIFY_ACT_ID', 'APIFY_TOKEN', 'ROBOT_1_ID', 'ROBOT_2_ID',
  'ROBOT_1_ORIGIN_URL', 'ROBOT_2_ORIGIN_URL', 'BROWSEAI_API_KEY',
  'MAKE_AI_WEBHOOK_URL', 'MAKE_NAIF_WEBHOOK_URL', 'MAKE_ERROR_WEBHOOK_URL', 'PUBLIC_BASE_URL',
]
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`[FATAL] Missing environment variable: ${key}`)
    process.exit(1)
  }
}

// ─── SABİTLER ───────────────────────────────────────────────────────────────
const CLUSTER_MERGE_DIST = 300
const MIN_LIQ_USD        = 1_000_000
const TP_PCT = 75, SL_PCT = 75, RISK_USD = 20
const ZLEMA_PERIOD1 = 8, ZLEMA_PERIOD2 = 21

const APIFY_BATCH_SIZE       = 5
const APIFY_BATCH_WAIT_MS    = 5 * 60 * 1000   // 2 batch arası bekleme
const APIFY_RETRY_GAP_MS     = 3000            // batch içi ardışık denemeler arası küçük tampon
const APIFY_NOTIFY_EVERY_N_BATCHES = 3

const ROBOT_TIMEOUT_MS = 20 * 60 * 1000

// ─── TİPLER ─────────────────────────────────────────────────────────────────
interface ClusterResult {
  cluster_up_btc: number | null
  cluster_up_usd: number | null
  cluster_dn_btc: number | null
  cluster_dn_usd: number | null
}
interface NaiveSetup {
  naive_direction: string | null
  naive_entry: number | null
  naive_tp: number | null
  naive_sl: number | null
  naive_rr: number | null
  naive_dist_ratio: number | null
  naive_pos_size: number | null
}
interface ZlemaResult {
  zlema_zone_4h: string
  ma1_last: number
  ma2_last: number
  last_candle_time: number
}
interface RobotState {
  status: 'idle' | 'running' | 'done' | 'error'
  taskId?: string
  attempt: number
}
interface Session {
  active: boolean
  startedAt: number
  apifyAttemptInBatch: number
  apifyBatchCount: number
  apifyRetryTimer?: ReturnType<typeof setTimeout>
  apifyRunId?: string
  apifyDatasetId?: string
  clusters?: ClusterResult
  zlema?: ZlemaResult
  naiveSetup?: NaiveSetup
  robot1: RobotState
  robot2: RobotState
  robotTimeoutTimer?: ReturnType<typeof setTimeout>
}

function freshSession(): Session {
  return {
    active: false,
    startedAt: 0,
    apifyAttemptInBatch: 0,
    apifyBatchCount: 0,
    robot1: { status: 'idle', attempt: 0 },
    robot2: { status: 'idle', attempt: 0 },
  }
}
let session: Session = freshSession()

function clearTimers(s: Session) {
  if (s.apifyRetryTimer) clearTimeout(s.apifyRetryTimer)
  if (s.robotTimeoutTimer) clearTimeout(s.robotTimeoutTimer)
}

// ─── HATA BİLDİRİMİ ────────────────────────────────────────────────────────
async function notifyError(source: string, reason: string, extra: Record<string, unknown> = {}) {
  try {
    await fetch(MAKE_ERROR_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source, reason, at: new Date().toISOString(), ...extra }),
    })
    console.log(`[ERROR-WEBHOOK] Sent (source=${source}, reason=${reason})`)
  } catch (err) {
    console.error('[ERROR-WEBHOOK] Failed to send:', err)
  }
}

// ─── CLUSTER HESABI (browse-ai-coordinator'dan birebir) ────────────────────
function computeClusters(heatmap: any): ClusterResult {
  const yAxis: number[] = heatmap?.y_axis
  const lld: number[][] = heatmap?.liquidation_leverage_data
  const candles: any[]  = heatmap?.price_candlesticks

  const empty: ClusterResult = {
    cluster_up_btc: null, cluster_up_usd: null,
    cluster_dn_btc: null, cluster_dn_usd: null,
  }
  if (!yAxis?.length || !lld?.length || !candles?.length) return empty

  const refPrice = parseFloat(candles[candles.length - 1][4])
  if (!refPrice || refPrice <= 0) return empty

  const liqByYi = new Map<number, number>()
  for (const [, yi, usd] of lld) {
    liqByYi.set(yi, (liqByYi.get(yi) || 0) + usd)
  }

  const up: Array<[number, number]> = []
  const dn: Array<[number, number]> = []
  for (const [yi, usd] of liqByYi.entries()) {
    if (usd < MIN_LIQ_USD) continue
    const price = yAxis[yi]
    if (price === undefined) continue
    if (price > refPrice) up.push([price, usd])
    else if (price < refPrice) dn.push([price, usd])
  }

  function dominantCluster(items: Array<[number, number]>) {
    if (!items.length) return null
    let peakPrice = items[0][0]
    let peakUsd   = items[0][1]
    for (const [price, usd] of items) {
      if (usd > peakUsd) { peakUsd = usd; peakPrice = price }
    }
    let total = 0
    let weightedSum = 0
    for (const [price, usd] of items) {
      if (Math.abs(price - peakPrice) <= CLUSTER_MERGE_DIST) {
        total += usd
        weightedSum += price * usd
      }
    }
    return { mid: weightedSum / total, usd: total }
  }

  const upC = dominantCluster(up)
  const dnC = dominantCluster(dn)

  return {
    cluster_up_btc: upC ? Math.round(upC.mid * 100) / 100 : null,
    cluster_up_usd: upC ? Math.round(upC.usd * 100) / 100 : null,
    cluster_dn_btc: dnC ? Math.round(dnC.mid * 100) / 100 : null,
    cluster_dn_usd: dnC ? Math.round(dnC.usd * 100) / 100 : null,
  }
}

async function fetchApifyDataset(datasetUrl: string, datasetId: string): Promise<any | null> {
  const url = datasetUrl || `https://api.apify.com/v2/datasets/${datasetId}/items?token=${APIFY_TOKEN}`
  try {
    const r = await fetch(url)
    const data = await r.json()
    return Array.isArray(data) ? data[0] : data
  } catch (err) {
    console.error('[APIFY] Dataset fetch failed:', err)
    return null
  }
}

// ─── NAİF SETUP (make_naive_setup.js — düzeltilmiş yön mantığıyla birebir) ─
function computeNaiveSetup(refPrice: number, upBtc: number, dnBtc: number): NaiveSetup {
  const empty: NaiveSetup = {
    naive_direction: null, naive_entry: null, naive_tp: null, naive_sl: null,
    naive_rr: null, naive_dist_ratio: null, naive_pos_size: null,
  }
  if (!(upBtc > refPrice && dnBtc < refPrice)) return empty

  const rawUpDist = upBtc - refPrice
  const rawDnDist = refPrice - dnBtc
  const naiveDir = rawUpDist < rawDnDist ? 'LONG' : 'SHORT'

  let tpDist: number, slDist: number, tpPrice: number, slPrice: number
  if (naiveDir === 'LONG') {
    tpDist = TP_PCT / 100 * rawUpDist
    slDist = SL_PCT / 100 * rawDnDist
    tpPrice = refPrice + tpDist
    slPrice = refPrice - slDist
  } else {
    tpDist = TP_PCT / 100 * rawDnDist
    slDist = SL_PCT / 100 * rawUpDist
    tpPrice = refPrice - tpDist
    slPrice = refPrice + slDist
  }
  if (tpDist <= 0 || slDist <= 0) return empty

  const rr = tpDist / slDist
  const distRatio = Math.min(rawUpDist, rawDnDist) > 0
    ? Math.max(rawUpDist, rawDnDist) / Math.min(rawUpDist, rawDnDist)
    : null
  const posSize = RISK_USD / slDist

  return {
    naive_direction: naiveDir,
    naive_entry: Math.round(refPrice * 100) / 100,
    naive_tp: Math.round(tpPrice * 100) / 100,
    naive_sl: Math.round(slPrice * 100) / 100,
    naive_rr: Math.round(rr * 1000) / 1000,
    naive_dist_ratio: distRatio !== null ? Math.round(distRatio * 1000) / 1000 : null,
    naive_pos_size: Math.round(posSize * 1_000_000) / 1_000_000,
  }
}

// ─── ZLEMA (make_zlema_zone.js — birebir) ──────────────────────────────────
interface Candle { time: number; open: number; high: number; low: number; close: number }

function trueRange(candles: Candle[]): number[] {
  const tr = [candles[0].high - candles[0].low]
  for (let i = 1; i < candles.length; i++) {
    const h = candles[i].high, l = candles[i].low, pc = candles[i - 1].close
    tr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)))
  }
  return tr
}
function kalmanFilter(src: number[], candles: Candle[]): number[] {
  const n = src.length
  const tr = trueRange(candles)
  let value1 = 0, value2 = 0, value3 = 0
  const out: number[] = []
  let prevSrc: number | null = null
  for (let i = 0; i < n; i++) {
    const d = prevSrc === null ? 0 : (src[i] - prevSrc)
    value1 = 0.2 * d + 0.8 * value1
    value2 = 0.1 * tr[i] + 0.8 * value2
    const lam = value2 !== 0 ? Math.abs(value1 / value2) : 0
    const inner = Math.pow(lam, 4) + 16 * Math.pow(lam, 2)
    const alpha = inner >= 0 ? (-Math.pow(lam, 2) + Math.sqrt(inner)) / 8 : 0
    value3 = alpha * src[i] + (1 - alpha) * value3
    out.push(value3)
    prevSrc = src[i]
  }
  return out
}
function ema(series: number[], period: number): number[] {
  const alpha = 2 / (period + 1)
  const out = [series[0]]
  for (let i = 1; i < series.length; i++) {
    out.push(alpha * series[i] + (1 - alpha) * out[i - 1])
  }
  return out
}
function zlema(src: number[], period: number): number[] {
  const lag = Math.round((period - 1) / 2)
  const emaData: number[] = []
  for (let i = 0; i < src.length; i++) {
    const lagged = (i - lag >= 0) ? src[i - lag] : src[0]
    emaData.push(src[i] + (src[i] - lagged))
  }
  return ema(emaData, period)
}
async function computeZlemaZone(): Promise<ZlemaResult | null> {
  try {
    const r = await fetch('https://fapi.binance.com/fapi/v1/klines?symbol=BTCUSDT&interval=4h&limit=150')
    const raw = await r.json()
    if (!Array.isArray(raw) || raw.length < 30) return null
    const candles: Candle[] = raw.map((k: any) => ({
      time: Number(k[0]), open: parseFloat(k[1]), high: parseFloat(k[2]),
      low: parseFloat(k[3]), close: parseFloat(k[4]),
    }))
    const hlc3 = candles.map(c => (c.high + c.low + c.close) / 3)
    const srcK = kalmanFilter(hlc3, candles)
    const ma1 = zlema(srcK, ZLEMA_PERIOD1)
    const ma2 = zlema(srcK, ZLEMA_PERIOD2)
    const n = candles.length
    let zone = 'NO_TRADE'
    if (n >= 3) {
      const ma1Inc = ma1[n - 1] > ma1[n - 2] && ma1[n - 2] > ma1[n - 3]
      const ma1Dec = ma1[n - 1] < ma1[n - 2] && ma1[n - 2] < ma1[n - 3]
      if (ma1[n - 1] > ma2[n - 1] && ma1Inc) zone = 'LONG'
      else if (ma1[n - 1] < ma2[n - 1] && ma1Dec) zone = 'SHORT'
    }
    return {
      zlema_zone_4h: zone,
      ma1_last: Math.round(ma1[n - 1] * 100) / 100,
      ma2_last: Math.round(ma2[n - 1] * 100) / 100,
      last_candle_time: candles[n - 1].time,
    }
  } catch (err) {
    console.error('[ZLEMA] Hesaplama hatası:', err)
    return null
  }
}

// ─── APIFY TETİKLEME + RETRY ────────────────────────────────────────────────
async function triggerApify() {
  const webhooksConfig = [{
    eventTypes: ['ACTOR.RUN.SUCCEEDED', 'ACTOR.RUN.FAILED', 'ACTOR.RUN.ABORTED', 'ACTOR.RUN.TIMED_OUT'],
    requestUrl: `${PUBLIC_BASE_URL}/webhook/apify`,
  }]
  const webhooksB64 = Buffer.from(JSON.stringify(webhooksConfig)).toString('base64')
  const url = `https://api.apify.com/v2/acts/${APIFY_ACT_ID}/runs?token=${APIFY_TOKEN}&webhooks=${encodeURIComponent(webhooksB64)}`
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol: 'BTC', model: 'model1', interval: '12h' }),
    })
    if (!res.ok) {
      console.error(`[APIFY] Trigger isteği başarısız: HTTP ${res.status}`)
      await handleApifyFailure('trigger_http_error')
      return
    }
    console.log(`[APIFY] Tetiklendi (batch=${session.apifyBatchCount + 1}, attempt=${session.apifyAttemptInBatch + 1})`)
  } catch (err) {
    console.error('[APIFY] Trigger isteği hata verdi:', err)
    await handleApifyFailure('trigger_network_error')
  }
}

async function handleApifyFailure(reason: string) {
  if (!session.active) return
  session.apifyAttemptInBatch++

  if (session.apifyAttemptInBatch < APIFY_BATCH_SIZE) {
    // Batch içi -- kısa tampon sonrası tekrar dene
    session.apifyRetryTimer = setTimeout(() => triggerApify(), APIFY_RETRY_GAP_MS)
    return
  }

  // Batch tükendi
  session.apifyBatchCount++
  session.apifyAttemptInBatch = 0
  console.warn(`[APIFY] Batch ${session.apifyBatchCount} tükendi (reason=${reason})`)

  if (session.apifyBatchCount % APIFY_NOTIFY_EVERY_N_BATCHES === 0) {
    await notifyError('apify', reason, {
      batch_count: session.apifyBatchCount,
      attempts_so_far: session.apifyBatchCount * APIFY_BATCH_SIZE,
    })
  }

  session.apifyRetryTimer = setTimeout(() => triggerApify(), APIFY_BATCH_WAIT_MS)
}

// ─── APIFY WEBHOOK ──────────────────────────────────────────────────────────
app.post('/webhook/apify', async (req: Request, res: Response) => {
  res.json({ ok: true }) // Apify'a hemen cevap ver, işleme arka planda devam

  if (!session.active) {
    console.log('[APIFY-WEBHOOK] Aktif session yok, görmezden geliniyor')
    return
  }

  const body = Array.isArray(req.body) ? req.body[0] : req.body
  const status = body.status || body.resource?.status
  if (status && status !== 'SUCCEEDED') {
    console.log(`[APIFY-WEBHOOK] Başarısız durum: ${status}`)
    await handleApifyFailure(`apify_status_${status}`)
    return
  }

  const runId      = body.id || body.resource?.id || ''
  const datasetId  = body.defaultDatasetId || body.resource?.defaultDatasetId || ''
  const datasetUrl = body.output?.dataset
    || (datasetId ? `https://api.apify.com/v2/datasets/${datasetId}/items?token=${APIFY_TOKEN}` : '')

  if (!datasetId && !datasetUrl) {
    await handleApifyFailure('apify_missing_dataset')
    return
  }

  const heatmap = await fetchApifyDataset(datasetUrl, datasetId)
  const clusters = heatmap ? computeClusters(heatmap) : {
    cluster_up_btc: null, cluster_up_usd: null, cluster_dn_btc: null, cluster_dn_usd: null,
  }
  const isEmpty = Object.values(clusters).every(v => v === null)

  if (isEmpty) {
    console.warn('[APIFY-WEBHOOK] Dataset boş -- başarısız sayılıyor')
    await handleApifyFailure('apify_empty_dataset')
    return
  }

  // ── APIFY BAŞARILI + DOLU -- retry döngüsü biter ───────────────────────
  if (session.apifyRetryTimer) clearTimeout(session.apifyRetryTimer)
  session.apifyRunId = runId
  session.apifyDatasetId = datasetId
  session.clusters = clusters
  console.log(`[APIFY-WEBHOOK] Başarılı. runId=${runId} clusters=`, clusters)

  // Ref fiyat -- heatmap'in kendi son mumundan (computeClusters ile aynı kaynak)
  const refPrice = parseFloat(heatmap?.price_candlesticks?.[heatmap.price_candlesticks.length - 1]?.[4])

  const zlema = await computeZlemaZone()
  session.zlema = zlema ?? undefined

  const naiveSetup = (refPrice && clusters.cluster_up_btc != null && clusters.cluster_dn_btc != null)
    ? computeNaiveSetup(refPrice, clusters.cluster_up_btc, clusters.cluster_dn_btc)
    : null
  session.naiveSetup = naiveSetup ?? undefined

  // ── HIZLI YOL -- robotları beklemeden hemen gönder ──────────────────────
  const aligned = !!(naiveSetup?.naive_direction && zlema?.zlema_zone_4h
    && naiveSetup.naive_direction === zlema.zlema_zone_4h)

  try {
    await fetch(MAKE_NAIF_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        apify_run_id: runId,
        analyzed_at: new Date().toISOString(),
        ref_price: refPrice,
        ...clusters,
        ...naiveSetup,
        zlema_zone_4h: zlema?.zlema_zone_4h ?? null,
        aligned,
      }),
    })
    console.log(`[NAIF-WEBHOOK] Gönderildi (aligned=${aligned})`)
  } catch (err) {
    console.error('[NAIF-WEBHOOK] Gönderim hatası:', err)
  }

  // ── YAVAŞ YOL -- robotları şimdi tetikle ─────────────────────────────────
  await triggerRobot('robot1')
  await triggerRobot('robot2')
  startRobotTimeout()
})

// ─── BROWSE AI TETİKLEME + RETRY ────────────────────────────────────────────
async function triggerRobot(which: 'robot1' | 'robot2') {
  const robotId   = which === 'robot1' ? ROBOT_1_ID : ROBOT_2_ID
  const originUrl = which === 'robot1' ? ROBOT_1_ORIGIN_URL : ROBOT_2_ORIGIN_URL
  const state = session[which]
  state.status = 'running'
  state.attempt++
  try {
    const res = await fetch(`https://api.browse.ai/v2/robots/${robotId}/tasks`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${BROWSEAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ inputParameters: { originUrl } }),
    })
    const data = await res.json()
    state.taskId = data?.result?.id
    console.log(`[BROWSEAI] ${which} tetiklendi (attempt=${state.attempt}, taskId=${state.taskId})`)
  } catch (err) {
    console.error(`[BROWSEAI] ${which} tetikleme hatası:`, err)
    state.status = 'error'
  }
}

function startRobotTimeout() {
  if (session.robotTimeoutTimer) clearTimeout(session.robotTimeoutTimer)
  session.robotTimeoutTimer = setTimeout(async () => {
    if (!session.active) return
    const pending: string[] = []
    if (session.robot1.status !== 'done') pending.push('robot1')
    if (session.robot2.status !== 'done') pending.push('robot2')
    if (pending.length === 0) return

    console.warn(`[TIMEOUT] 20dk doldu, hâlâ bekleyen: ${pending.join(', ')}`)
    await notifyError('browseai_timeout', '20_minute_timeout', { pending })
    for (const which of pending) {
      await triggerRobot(which as 'robot1' | 'robot2')
    }
    startRobotTimeout() // yeniden başlat
  }, ROBOT_TIMEOUT_MS)
}

// ─── BROWSE AI WEBHOOK ──────────────────────────────────────────────────────
app.post('/webhook/browseai', async (req: Request, res: Response) => {
  res.json({ ok: true })

  if (!session.active) {
    console.log('[BROWSEAI-WEBHOOK] Aktif session yok, görmezden geliniyor')
    return
  }

  const body = req.body
  const robotId = body?.task?.robotId
  const status  = body?.task?.status

  let which: 'robot1' | 'robot2' | null = null
  if (robotId === ROBOT_1_ID) which = 'robot1'
  else if (robotId === ROBOT_2_ID) which = 'robot2'
  if (!which) {
    console.log('[BROWSEAI-WEBHOOK] Bilinmeyen robotId:', robotId)
    return
  }

  const state = session[which]

  if (status === 'successful') {
    state.status = 'done'
    console.log(`[BROWSEAI-WEBHOOK] ${which} başarılı`)
  } else {
    console.warn(`[BROWSEAI-WEBHOOK] ${which} beklenmeyen durum: ${status}`)
    state.status = 'error'
    await triggerRobot(which)
    return
  }

  if (session.robot1.status === 'done' && session.robot2.status === 'done') {
    await finalizeCycle()
  }
})

// ─── SONLANDIRMA -- AI AKIŞINA GÖNDER ───────────────────────────────────────
async function finalizeCycle() {
  if (session.robotTimeoutTimer) clearTimeout(session.robotTimeoutTimer)

  const payload = {
    robot1: { robotId: ROBOT_1_ID, taskId: session.robot1.taskId },
    robot2: { robotId: ROBOT_2_ID, taskId: session.robot2.taskId },
    apify: {
      actId: APIFY_ACT_ID,
      runId: session.apifyRunId,
      datasetId: session.apifyDatasetId,
      ...session.clusters,
    },
    apify_run_id: session.apifyRunId, // Make'in AI akışında UPSERT/order eşleştirmesi için kolay erişim
    completedAt: new Date().toISOString(),
  }

  console.log('[FINALIZE] AI akışına gönderiliyor:', payload)
  try {
    await fetch(MAKE_AI_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
  } catch (err) {
    console.error('[FINALIZE] AI webhook gönderim hatası:', err)
  }

  session = freshSession()
  console.log('[FINALIZE] Session sıfırlandı, yeni /start bekleniyor')
}

// ─── BAŞLAT ─────────────────────────────────────────────────────────────────
app.post('/start', async (_req: Request, res: Response) => {
  if (session.active) {
    console.warn('[START] Zaten aktif bir session var, yeni tetikleme görmezden geliniyor')
    return res.status(409).json({ ok: false, reason: 'already active' })
  }
  session = freshSession()
  session.active = true
  session.startedAt = Date.now()
  console.log('[START] Yeni döngü başlıyor')
  res.json({ ok: true, started: true })
  await triggerApify()
})

app.post('/reset', (_req: Request, res: Response) => {
  clearTimers(session)
  session = freshSession()
  console.log('[RESET] Manuel sıfırlama')
  res.json({ ok: true })
})

app.get('/health', (_req: Request, res: Response) => {
  res.json({
    ok: true,
    active: session.active,
    ageSeconds: session.active ? Math.round((Date.now() - session.startedAt) / 1000) : null,
    apify: { batchCount: session.apifyBatchCount, attemptInBatch: session.apifyAttemptInBatch, runId: session.apifyRunId ?? null },
    robot1: session.robot1,
    robot2: session.robot2,
    uptime: process.uptime(),
  })
})

app.listen(PORT, () => {
  console.log(`[START] Naif Fast Orchestrator port ${PORT}'de çalışıyor`)
})
