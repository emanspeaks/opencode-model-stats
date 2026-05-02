/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { appendFileSync } from "node:fs"
import { resolve } from "node:path"
import { createMemo, createSignal } from "solid-js"

type StreamSample = {
  at: number
  tokens: number
}

const STREAM_WINDOW_MS = 5_000
const LIVE_STALE_MS = 1_500
const SINGLE_SAMPLE_MS = 1_000
const DEFAULT_UPDATE_INTERVAL_MS = 250
const EMA_ALPHA = 0.3  // weight for newest batch vs history

type PrefillProgress = {
  sessionID: string
  messageID: string
  total: number
  cache: number
  processed: number
  timeMs: number
  receivedAt: number
  emaRate: number
}

type MessageTiming = {
  sessionID: string
  requestStartAt: number
  firstResponseAt?: number
  firstTokenAt?: number
  lastTokenAt?: number
}

type SessionAverage = {
  totalTokens: number
  totalDurationMs: number
  totalTtftMs: number
  messageCount: number
}

type TrackerState = {
  streamSamplesBySession: Record<string, StreamSample[]>
  messageTimingByID: Record<string, MessageTiming>
  sessionAverageByID: Record<string, SessionAverage>
  prefillBySession: Record<string, PrefillProgress>
  lastPrefillByMessage: Record<string, PrefillProgress>
}

type WsPrefillMessage = {
  session_id?: unknown
  sessionID?: unknown
  message_id?: unknown
  messageID?: unknown
  total?: unknown
  cache?: unknown
  processed?: unknown
  time_ms?: unknown
  timeMs?: unknown
  done?: unknown
  started?: unknown
}

function readString(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) return value
  return undefined
}

function readNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string" && value.length > 0) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

function readBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value
  if (typeof value === "string") {
    if (value === "true") return true
    if (value === "false") return false
  }
  return undefined
}

function estimateStreamTokens(delta: string) {
  return Math.max(1, Math.ceil(Buffer.byteLength(delta, "utf8") / 5))
}

function formatRate(value: number) {
  if (!Number.isFinite(value) || value <= 0) return undefined
  if (value >= 100) return `${Math.round(value)}`
  if (value >= 10) return `${value.toFixed(1)}`
  return `${value.toFixed(2)}`
}

function formatTtft(value: number) {
  if (!Number.isFinite(value) || value < 0) return undefined
  return `${value.toFixed(1)}s`
}

function activeDurationMs(samples: StreamSample[], tailAt?: number) {
  if (samples.length === 0) return 0
  if (samples.length === 1) {
    const tailDuration = tailAt ? Math.max(0, tailAt - samples[0].at) : SINGLE_SAMPLE_MS
    return Math.min(Math.max(tailDuration, 250), SINGLE_SAMPLE_MS)
  }

  let duration = 0
  for (let i = 1; i < samples.length; i++) {
    duration += Math.max(0, samples[i].at - samples[i - 1].at)
  }

  if (tailAt) {
    duration += Math.max(0, tailAt - samples[samples.length - 1].at)
  }

  return Math.max(duration, SINGLE_SAMPLE_MS)
}

function parseWsMessage(value: unknown): { sessionID: string; messageID: string; done: boolean; started: boolean; total: number; cache: number; processed: number; timeMs: number } | undefined {
  if (!value || typeof value !== "object") return undefined
  const data = value as WsPrefillMessage

  const sessionID = readString(data.session_id) ?? readString(data.sessionID)
  if (!sessionID) return undefined

  const messageID = readString(data.message_id) ?? readString(data.messageID) ?? ""
  const done = readBoolean(data.done) === true
  const started = readBoolean(data.started) !== false

  if (done) return { sessionID, messageID, done: true, started, total: 0, cache: 0, processed: 0, timeMs: 0 }

  const total = readNumber(data.total)
  const cache = readNumber(data.cache)
  const processed = readNumber(data.processed)
  const timeMs = readNumber(data.time_ms) ?? readNumber(data.timeMs)

  if (
    total === undefined
    || cache === undefined
    || processed === undefined
    || timeMs === undefined
  ) return undefined

  if (total <= 0 || cache < 0 || processed < 0 || timeMs < 0) return undefined

  return { sessionID, messageID, done: false, started, total, cache, processed, timeMs }
}

function formatPrefillEta(prefill: PrefillProgress, last: PrefillProgress | undefined): string {
  const realProcessed = prefill.processed - prefill.cache
  const realTotal = prefill.total - prefill.cache
  if (realProcessed <= 0 || prefill.timeMs <= 0) return ""

  const lastValid = last && last.messageID === prefill.messageID && prefill.timeMs > last.timeMs
  const lastProcessed = lastValid ? last.processed - last.cache : 0
  const lastTimeMs = lastValid ? last.timeMs : 0
  const deltaProcessed = realProcessed - lastProcessed
  const deltaMs = prefill.timeMs - lastTimeMs
  const batchRate = deltaMs > 0 ? deltaProcessed / deltaMs * 1000 : 0
  const emaRate = lastValid && last.emaRate > 0 ? (1 - EMA_ALPHA) * last.emaRate + EMA_ALPHA * batchRate : batchRate
  prefill.emaRate = emaRate
  if (!Number.isFinite(emaRate) || emaRate <= 0) return ""
  let ratestr = ` | ${formatRate(batchRate)} t/s (EMA ${formatRate(emaRate)})`
  const remainingSec = (realTotal*realTotal - realProcessed*realProcessed) / (2*emaRate*realProcessed)
  if (!Number.isFinite(remainingSec) || remainingSec < 1) return ratestr
  return `${ratestr} | ~${Math.floor(remainingSec)}s`
}

function SessionPromptRight(props: {
  api: Parameters<TuiPlugin>[0]
  sessionID: string
  tracker: TrackerState
  version: () => number
  clock: () => number
}) {
  const sessionAverage = createMemo(() => {
    props.version()
    const totals = props.tracker.sessionAverageByID[props.sessionID]
    if (!totals || totals.totalTokens <= 0 || totals.totalDurationMs <= 0) return undefined
    return formatRate(totals.totalTokens / (totals.totalDurationMs / 1000))
  })

  const sessionTtft = createMemo(() => {
    props.version()
    const totals = props.tracker.sessionAverageByID[props.sessionID]
    if (!totals || totals.messageCount <= 0 || totals.totalTtftMs < 0) return undefined
    return formatTtft(totals.totalTtftMs / totals.messageCount / 1000)
  })

  const liveTps = createMemo(() => {
    props.version()
    props.clock()
    const status = props.api.state.session.status(props.sessionID)
    if (status?.type === "idle") return undefined
    const samples = props.tracker.streamSamplesBySession[props.sessionID] ?? []
    if (samples.length === 0) return undefined
    const now = Date.now()
    const relevant = samples.filter((sample) => now - sample.at <= STREAM_WINDOW_MS)
    if (relevant.length === 0) return undefined
    const lastSample = relevant[relevant.length - 1]
    if (!lastSample || now - lastSample.at > LIVE_STALE_MS) return undefined
    const total = relevant.reduce((sum, sample) => sum + sample.tokens, 0)
    const durationSeconds = activeDurationMs(relevant, now) / 1000
    if (durationSeconds <= 0) return undefined
    return formatRate(total / durationSeconds)
  })

  const text = createMemo(() => {
    props.version()
    props.clock()

    const status = props.api.state.session.status(props.sessionID)
    const prefill = props.tracker.prefillBySession[props.sessionID]
    if (status?.type !== "idle" && prefill && prefill.total > 0) {
      const pct = Math.floor((prefill.processed / prefill.total) * 100)
      const last = prefill.messageID ? props.tracker.lastPrefillByMessage[prefill.messageID] : undefined
      return `Prefill ${prefill.processed.toLocaleString()}/${prefill.total.toLocaleString()} (${pct}%)${formatPrefillEta(prefill, last)}`
    }

    const live = liveTps() ?? "-"
    const avg = sessionAverage() ?? "-"
    const ttft = sessionTtft() ?? "-"
    return `${live} t/s | AVG ${avg} t/s | TTFT ${ttft}`
  })

  return <>{text() ? <text fg={props.api.theme.current.textMuted}>{text()}</text> : null}</>
}

const tui: TuiPlugin = async (api, options) => {
  const log = (() => {
    const opt = options?.["tuiDebug"]
    if (!opt) return undefined
    const path = resolve(typeof opt === "string" && opt.length > 0 ? opt : "opencode-model-stats-tui.log")
    const write = (line: string) => appendFileSync(path, line + "\n", "utf8")
    write(`\n=== opencode-model-stats/tui started ${new Date().toISOString()} ===`)
    console.log(`[opencode-model-stats/tui] debug log: ${path}`)
    return (...args: unknown[]) => {
      const ts = new Date().toISOString()
      write(`${ts} ${args.map((a) => (typeof a === "object" ? JSON.stringify(a) : String(a))).join(" ")}`)
    }
  })()

  const updateIntervalMs = (() => {
    const n = Number(options?.prefillPollMs)
    return Number.isFinite(n) && n > 0 ? Math.max(100, n) : DEFAULT_UPDATE_INTERVAL_MS
  })()

  const clog = (...args: unknown[]) => {
    console.log("[opencode-model-stats/tui]", ...args)
    log?.(...args)
  }

  // Explicit config URL overrides auto-derivation; null means derive from each session's model URL
  const configWsUrl: string | null = typeof options?.prefillWsUrl === "string" && options.prefillWsUrl.length > 0
    ? options.prefillWsUrl
    : null

  log?.("tui plugin initialized" + (configWsUrl ? ", wsUrl=" + configWsUrl : ", wsUrl=auto (derived from model API URL)"))

  const tracker: TrackerState = {
    streamSamplesBySession: {},
    messageTimingByID: {},
    sessionAverageByID: {},
    prefillBySession: {},
    lastPrefillByMessage: {},
  }
  const [version, setVersion] = createSignal(0)
  const [clock, setClock] = createSignal(Date.now())

  const bump = () => setVersion((v) => v + 1)

  const clearPrefillProgress = (sessionID: string) => {
    const prev = tracker.prefillBySession[sessionID]
    if (!prev) return
    if (prev.messageID) delete tracker.lastPrefillByMessage[prev.messageID]
    delete tracker.prefillBySession[sessionID]
    bump()
  }

  const prunePrefill = () => {
    let changed = false

    for (const sessionID of Object.keys(tracker.prefillBySession)) {
      if (api.state.session.status(sessionID)?.type === "idle") {
        const prev = tracker.prefillBySession[sessionID]
        if (prev?.messageID) delete tracker.lastPrefillByMessage[prev.messageID]
        delete tracker.prefillBySession[sessionID]
        changed = true
      }
    }

    for (const [msgID, prefill] of Object.entries(tracker.lastPrefillByMessage)) {
      if (api.state.session.status(prefill.sessionID)?.type === "idle") {
        delete tracker.lastPrefillByMessage[msgID]
        changed = true
      }
    }

    for (const [messageID, timing] of Object.entries(tracker.messageTimingByID)) {
      if (api.state.session.status(timing.sessionID)?.type === "idle") {
        delete tracker.messageTimingByID[messageID]
        changed = true
      }
    }

    if (changed) bump()
  }

  const setPrefillProgress = (sessionID: string, next: PrefillProgress | undefined) => {
    const prev = tracker.prefillBySession[sessionID]

    if (!next) {
      if (!prev) return
      if (prev.messageID) delete tracker.lastPrefillByMessage[prev.messageID]
      delete tracker.prefillBySession[sessionID]
      bump()
      return
    }

    if (
      prev
      && prev.messageID === next.messageID
      && prev.total === next.total
      && prev.cache === next.cache
      && prev.processed === next.processed
      && prev.timeMs === next.timeMs
    ) {
      return
    }

    if (prev && next.messageID) {
      if (prev.messageID === next.messageID) {
        tracker.lastPrefillByMessage[next.messageID] = prev
      } else if (prev.messageID) {
        delete tracker.lastPrefillByMessage[prev.messageID]
      }
    }

    tracker.prefillBySession[sessionID] = next
    bump()
  }

  // Per-session current model WS URL.
  const currentWsUrlBySession: Record<string, string> = {}
  // Active WebSocket instances keyed by URL
  const wsByUrl = new Map<string, WebSocket>()
  // Pending reconnect timers keyed by URL
  const wsReconnectsByUrl = new Map<string, ReturnType<typeof setTimeout>>()
  // Prevent repetitive shape dumps when derivation fails repeatedly in the same session.
  const wsDerivationShapeLogged = new Set<string>()
  let wsDisposed = false

  const asRecord = (value: unknown): Record<string, unknown> | undefined => {
    if (!value || typeof value !== "object") return undefined
    return value as Record<string, unknown>
  }

  const readApiCandidate = (value: unknown): string | undefined => {
    const obj = asRecord(value)
    if (!obj) return undefined
    return readString(obj.url)
      ?? readString(obj.baseUrl)
      ?? readString(obj.baseURL)
      ?? readString(obj.apiUrl)
      ?? readString(obj.apiURL)
      ?? readString(obj.endpoint)
  }

  const toPrefillWsUrl = (raw: string): string | undefined => {
    try {
      const u = new URL(raw)
      const wsScheme = u.protocol === "https:" ? "wss:" : u.protocol === "http:" ? "ws:" : u.protocol
      if (wsScheme !== "ws:" && wsScheme !== "wss:") return undefined
      return `${wsScheme}//${u.host}/prefill-ws`
    } catch {
      return undefined
    }
  }

  const pickApiUrl = (model: unknown, provider: unknown): string | undefined => {
    const modelObj = asRecord(model)
    const providerObj = asRecord(provider)
    // provider.options.baseURL is where custom/local providers store the URL in newer opencode versions
    const providerOptions = asRecord(providerObj?.options)
    return readApiCandidate(modelObj?.api)
      ?? readApiCandidate(providerObj?.api)
      ?? readString(modelObj?.url)
      ?? readString(modelObj?.baseUrl)
      ?? readString(modelObj?.baseURL)
      ?? readString(modelObj?.apiUrl)
      ?? readString(modelObj?.apiURL)
      ?? readString(modelObj?.endpoint)
      ?? readString(providerObj?.url)
      ?? readString(providerObj?.baseUrl)
      ?? readString(providerObj?.baseURL)
      ?? readString(providerObj?.apiUrl)
      ?? readString(providerObj?.apiURL)
      ?? readString(providerObj?.endpoint)
      ?? readString(providerOptions?.baseURL)
      ?? readString(providerOptions?.baseUrl)
      ?? readString(providerOptions?.url)
      ?? readString(providerOptions?.apiUrl)
      ?? readString(providerOptions?.endpoint)
  }

  const readModelRef = (msg: unknown): { providerID: string; modelID: string } | undefined => {
    if (!msg || typeof msg !== "object") return undefined
    const data = msg as {
      // legacy: model ref directly on message
      model?: {
        providerID?: unknown
        providerId?: unknown
        provider?: { id?: unknown }
        modelID?: unknown
        modelId?: unknown
        id?: unknown
      }
      // current SDK v2: model ref under metadata.assistant
      metadata?: {
        assistant?: {
          providerID?: unknown
          providerId?: unknown
          modelID?: unknown
          modelId?: unknown
        }
      }
    }

    const assistant = data.metadata?.assistant
    const providerID = readString(data.model?.providerID)
      ?? readString(data.model?.providerId)
      ?? readString(data.model?.provider?.id)
      ?? readString(assistant?.providerID)
      ?? readString(assistant?.providerId)
    const modelID = readString(data.model?.modelID)
      ?? readString(data.model?.modelId)
      ?? readString(data.model?.id)
      ?? readString(assistant?.modelID)
      ?? readString(assistant?.modelId)

    if (!providerID || !modelID) return undefined
    return { providerID, modelID }
  }

  const deriveWsUrl = (sessionID: string): { url: string | null; reason: string } => {
    const messages = api.state.session.messages(sessionID)
    if (messages.length === 0) {
      return { url: null, reason: "no session messages" }
    }

    let sawModelRef = false
    let unresolvedProviderOrModel = 0
    let missingApiUrl = 0
    let invalidApiUrl = 0

    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]
      const modelRef = readModelRef(msg)
      if (!modelRef) continue
      sawModelRef = true

      const provider = api.state.provider.find((p) => p.id === modelRef.providerID)
      const model = provider?.models[modelRef.modelID]
      if (!provider || !model) {
        unresolvedProviderOrModel++
        continue
      }

      const apiUrl = pickApiUrl(model, provider)
      if (!apiUrl) {
        missingApiUrl++
        continue
      }

      const wsUrl = toPrefillWsUrl(apiUrl)
      if (!wsUrl) {
        invalidApiUrl++
        continue
      }

      return { url: wsUrl, reason: "ok" }
    }

    if (!sawModelRef) return { url: null, reason: "no message model refs found" }
    if (unresolvedProviderOrModel > 0) return { url: null, reason: `provider/model unresolved for ${unresolvedProviderOrModel} message(s)` }
    if (missingApiUrl > 0) return { url: null, reason: `model.api.url missing for ${missingApiUrl} message(s)` }
    if (invalidApiUrl > 0) return { url: null, reason: `invalid model.api.url for ${invalidApiUrl} message(s)` }
    return { url: null, reason: "unknown derivation failure" }
  }

  const isUrlWanted = (url: string): boolean => {
    if (wsDisposed) return false
    if (url === configWsUrl) return true
    return Object.values(currentWsUrlBySession).some((u) => u === url)
  }

  const clearPrefillForUrl = (url: string) => {
    let changed = false
    for (const [sessionID, u] of Object.entries(currentWsUrlBySession)) {
      if (u === url && tracker.prefillBySession[sessionID]) {
        delete tracker.prefillBySession[sessionID]
        changed = true
      }
    }
    if (changed) bump()
  }

  const scheduleReconnect = (url: string) => {
    if (wsDisposed || wsReconnectsByUrl.has(url)) return
    const timer = setTimeout(() => {
      wsReconnectsByUrl.delete(url)
      if (!wsDisposed && isUrlWanted(url)) openWs(url)
    }, 2_000)
    wsReconnectsByUrl.set(url, timer)
  }

  const openWs = (url: string) => {
    if (wsDisposed) {
      log?.("ws: skipped connect (disposed): " + url)
      return
    }
    if (wsByUrl.has(url)) {
      log?.("ws: skipped connect (already open): " + url)
      return
    }
    log?.("ws: connecting to " + url)
    let socket: WebSocket
    try {
      socket = new WebSocket(url)
    } catch (err) {
      log?.("ws: failed to construct WebSocket:", err)
      scheduleReconnect(url)
      return
    }
    wsByUrl.set(url, socket)

    socket.onopen = () => {
      clog("ws: connected:", url)
    }

    socket.onmessage = (evt) => {
      try {
        const raw = typeof evt.data === "string" ? evt.data : String(evt.data)
        log?.("ws: raw message:", raw)
        const parsed = JSON.parse(raw) as unknown
        const msg = parseWsMessage(parsed)
        if (!msg) {
          // Log the actual keys present so shape mismatches are immediately visible.
          if (parsed && typeof parsed === "object") {
            const keys = Object.keys(parsed as object)
            const sample: Record<string, unknown> = {}
            for (const k of keys) sample[k] = typeof (parsed as Record<string, unknown>)[k]
            clog("ws: message rejected by parser — keys and value types:", JSON.stringify(sample))
          } else {
            clog("ws: message rejected by parser — not an object, typeof:", typeof parsed)
          }
          return
        }
        log?.("ws: parsed:", msg)
        if (msg.done || !msg.started) {
          clearPrefillProgress(msg.sessionID)
        } else {
          setPrefillProgress(msg.sessionID, {
            sessionID: msg.sessionID,
            messageID: msg.messageID,
            total: msg.total,
            cache: msg.cache,
            processed: msg.processed,
            timeMs: msg.timeMs,
            receivedAt: Date.now(),
            emaRate: -1,
          })
        }
      } catch (err) {
        log?.("ws: message parse error:", err)
      }
    }

    socket.onclose = (evt) => {
      if (wsByUrl.get(url) === socket) wsByUrl.delete(url)
      clearPrefillForUrl(url)
      if (isUrlWanted(url)) {
        clog(`ws: closed (code=${evt.code}, clean=${evt.wasClean}, reason=${evt.reason || ""}), reconnecting in 2s:`, url)
        scheduleReconnect(url)
      } else {
        clog(`ws: closed (code=${evt.code}, clean=${evt.wasClean}, reason=${evt.reason || ""}):`, url)
      }
    }

    socket.onerror = () => {
      log?.("ws: error (close will follow):", url)
    }
  }

  const ensureWsConnected = (url: string) => {
    if (wsDisposed || wsByUrl.has(url)) return
    openWs(url)
  }

  const ensureSessionWs = (sessionID: string) => {
    const derived = configWsUrl
      ? { url: configWsUrl, reason: "config override" }
      : deriveWsUrl(sessionID)
    const url = derived.url
    if (!url) {
      log?.(`ws: no derived url for session ${sessionID} (${derived.reason})`)
      if (!wsDerivationShapeLogged.has(sessionID)) {
        wsDerivationShapeLogged.add(sessionID)
        const messages = api.state.session.messages(sessionID)
        const recent = messages.slice(-3)
        const shapes = recent.map((msg) => {
          const data = asRecord(msg)
          const model = asRecord(data?.model)
          const api = asRecord(model?.api)
          return {
            role: readString(data?.role) ?? "",
            modelKeys: model ? Object.keys(model) : [],
            apiKeys: api ? Object.keys(api) : [],
          }
        })
        log?.("ws: derivation shape sample", { sessionID, messageCount: messages.length, recentShapes: shapes })
      }
      return
    }

    const oldUrl = currentWsUrlBySession[sessionID]
    currentWsUrlBySession[sessionID] = url
    ensureWsConnected(url)
    if (oldUrl && oldUrl !== url) closeWsIfUnwanted(oldUrl)
  }

  const closeWsIfUnwanted = (url: string) => {
    if (isUrlWanted(url)) return
    const timer = wsReconnectsByUrl.get(url)
    if (timer) { clearTimeout(timer); wsReconnectsByUrl.delete(url) }
    const socket = wsByUrl.get(url)
    if (socket) {
      log?.("ws: closing unwanted socket: " + url)
      socket.close()
    }  // onclose handles wsByUrl.delete and clearPrefillForUrl
  }

  if (configWsUrl) openWs(configWsUrl)

  const pruneSamples = (now = Date.now()) => {
    let changed = false

    for (const [sessionID, samples] of Object.entries(tracker.streamSamplesBySession)) {
      const next = samples.filter((sample) => now - sample.at <= STREAM_WINDOW_MS)
      if (next.length !== samples.length) {
        changed = true
        if (next.length > 0) tracker.streamSamplesBySession[sessionID] = next
        else delete tracker.streamSamplesBySession[sessionID]
      }
    }

    if (changed) bump()
  }

  const clearLiveSamples = (sessionID: string) => {
    if (!tracker.streamSamplesBySession[sessionID]?.length) return
    delete tracker.streamSamplesBySession[sessionID]
    bump()
  }

  const appendSample = (sessionID: string, messageID: string, sample: StreamSample) => {
    const now = sample.at
    tracker.streamSamplesBySession[sessionID] = [
      ...(tracker.streamSamplesBySession[sessionID] ?? []).filter((item) => now - item.at <= STREAM_WINDOW_MS),
      sample,
    ]
    const timing = tracker.messageTimingByID[messageID]
    if (timing) {
      tracker.messageTimingByID[messageID] = timing.firstTokenAt
        ? { ...timing, lastTokenAt: now }
        : {
            ...timing,
            firstResponseAt: timing.firstResponseAt ?? now,
            firstTokenAt: now,
            lastTokenAt: now,
          }
    }
    bump()
  }

  const onDelta = api.event.on("message.part.delta", (evt) => {
    if (evt.properties.field !== "text") return
    const parts = api.state.part(evt.properties.messageID)
    const part = parts.find((item) => item.id === evt.properties.partID)
    if (!part) return
    if (part.type !== "text" && part.type !== "reasoning") return
    clearPrefillProgress(evt.properties.sessionID)
    appendSample(evt.properties.sessionID, evt.properties.messageID, {
      at: Date.now(),
      tokens: estimateStreamTokens(evt.properties.delta),
    })
  })

  const onMessage = api.event.on("message.updated", (evt) => {
    if (evt.properties.info.role === "user") {
      ensureSessionWs(evt.properties.sessionID)
      return
    }

    if (evt.properties.info.role !== "assistant") return

    if (!evt.properties.info.time.completed) {
      const existing = tracker.messageTimingByID[evt.properties.info.id]
      log?.(`onMessage assistant incomplete: msgID=${evt.properties.info.id} existing=${!!existing}`)
      // TUI may attach in the middle of generation without a fresh user update event.
      // Ensure prefill websocket is connected for this session in that case.
      ensureSessionWs(evt.properties.sessionID)
      tracker.messageTimingByID[evt.properties.info.id] = {
        sessionID: evt.properties.sessionID,
        requestStartAt: evt.properties.info.time.created,
        firstResponseAt: existing?.firstResponseAt,
        firstTokenAt: existing?.firstTokenAt,
        lastTokenAt: existing?.lastTokenAt,
      }
      bump()
      return
    }

    clearPrefillProgress(evt.properties.sessionID)

    const timing = tracker.messageTimingByID[evt.properties.info.id]
    if (timing?.sessionID === evt.properties.sessionID && typeof timing.firstResponseAt === "number") {
      const totalTokens = evt.properties.info.tokens.output + evt.properties.info.tokens.reasoning
      const durationMs = timing.firstTokenAt && timing.lastTokenAt
        ? Math.max(timing.lastTokenAt - timing.firstTokenAt, SINGLE_SAMPLE_MS)
        : undefined
      const ttftMs = Math.max(timing.firstResponseAt - timing.requestStartAt, 0)
      if (totalTokens > 0 && durationMs) {
        const totals = tracker.sessionAverageByID[evt.properties.sessionID] ?? {
          totalTokens: 0,
          totalDurationMs: 0,
          totalTtftMs: 0,
          messageCount: 0,
        }
        tracker.sessionAverageByID[evt.properties.sessionID] = {
          totalTokens: totals.totalTokens + totalTokens,
          totalDurationMs: totals.totalDurationMs + durationMs,
          totalTtftMs: totals.totalTtftMs + ttftMs,
          messageCount: totals.messageCount + 1,
        }
      }
    }
    delete tracker.messageTimingByID[evt.properties.info.id]
    pruneSamples(evt.properties.info.time.completed)
    bump()
  })

  const onPart = api.event.on("message.part.updated", (evt) => {
    if (evt.properties.part.type !== "tool") return
    if (
      evt.properties.part.state.status === "running" ||
      evt.properties.part.state.status === "completed" ||
      evt.properties.part.state.status === "error"
    ) {
      clearLiveSamples(evt.properties.sessionID)
    }
    const timing = tracker.messageTimingByID[evt.properties.part.messageID]
    if (!timing) return
    if (evt.properties.part.state.status === "pending") {
      tracker.messageTimingByID[evt.properties.part.messageID] = {
        ...timing,
        firstResponseAt: timing.firstResponseAt ?? evt.properties.time,
      }
      bump()
    }
  })

  const timer = setInterval(() => {
    setClock(Date.now())
    pruneSamples()
    prunePrefill()
  }, updateIntervalMs)

  api.lifecycle.onDispose(() => {
    log?.(`ws: disposing plugin; reconnectTimers=${wsReconnectsByUrl.size} openSockets=${wsByUrl.size}`)
    onDelta()
    onMessage()
    onPart()
    clearInterval(timer)
    wsDisposed = true
    for (const timer of wsReconnectsByUrl.values()) clearTimeout(timer)
    wsReconnectsByUrl.clear()
    for (const [url, socket] of wsByUrl.entries()) {
      log?.("ws: closing socket on dispose: " + url)
      socket.close()
    }
    wsByUrl.clear()
  })

  api.slots.register({
    slots: {
      session_prompt_right(_ctx, value) {
        return <SessionPromptRight api={api} sessionID={value.session_id} tracker={tracker} version={version} clock={clock} />
      },
    },
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id: "opencode-model-stats",
  tui,
}

export default plugin
