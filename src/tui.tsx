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
const DEFAULT_PREFILL_WS_URL = "ws://127.0.0.1:8080/prefill-ws"
const DEFAULT_UPDATE_INTERVAL_MS = 250

type PrefillProgress = {
  sessionID: string
  total: number
  cache: number
  processed: number
  timeMs: number
  receivedAt: number
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
}

type WsPrefillMessage = {
  session_id?: unknown
  total?: unknown
  cache?: unknown
  processed?: unknown
  time_ms?: unknown
  done?: unknown
  started?: unknown
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

function parseWsMessage(value: unknown): { sessionID: string; done: boolean; started: boolean; total: number; cache: number; processed: number; timeMs: number } | undefined {
  if (!value || typeof value !== "object") return undefined
  const data = value as WsPrefillMessage

  const sessionID = typeof data.session_id === "string" && data.session_id.length > 0 ? data.session_id : undefined
  if (!sessionID) return undefined

  const done = data.done === true
  const started = data.started !== false

  if (done) return { sessionID, done: true, started, total: 0, cache: 0, processed: 0, timeMs: 0 }

  if (
    typeof data.total !== "number" || !Number.isFinite(data.total)
    || typeof data.cache !== "number" || !Number.isFinite(data.cache)
    || typeof data.processed !== "number" || !Number.isFinite(data.processed)
    || typeof data.time_ms !== "number" || !Number.isFinite(data.time_ms)
  ) return undefined

  if (data.total <= 0 || data.cache < 0 || data.processed < 0 || data.time_ms < 0) return undefined

  return { sessionID, done: false, started, total: data.total, cache: data.cache, processed: data.processed, timeMs: data.time_ms }
}

function formatPrefillEta(prefill: PrefillProgress): string {
  const realProcessed = prefill.processed - prefill.cache
  const realTotal = prefill.total - prefill.cache
  if (realProcessed <= 0 || prefill.timeMs <= 0) return ""

  const realRatePerSec = realProcessed / (prefill.timeMs / 1000)
  if (!Number.isFinite(realRatePerSec) || realRatePerSec <= 0) return ""

  const remainingSec = (realTotal - realProcessed) / realRatePerSec
  if (!Number.isFinite(remainingSec) || remainingSec < 1) return ""
  return ` · ~${Math.floor(remainingSec)}s left`
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
      return `Prefill ${prefill.processed.toLocaleString()}/${prefill.total.toLocaleString()} (${pct}%)${formatPrefillEta(prefill)}`
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

  const prefillWsUrl = typeof options?.prefillWsUrl === "string" && options.prefillWsUrl.length > 0
    ? options.prefillWsUrl
    : DEFAULT_PREFILL_WS_URL
  const updateIntervalMs = (() => {
    const n = Number(options?.prefillPollMs)
    return Number.isFinite(n) && n > 0 ? Math.max(100, n) : DEFAULT_UPDATE_INTERVAL_MS
  })()

  log?.("tui plugin initialized, wsUrl=" + prefillWsUrl)

  const tracker: TrackerState = {
    streamSamplesBySession: {},
    messageTimingByID: {},
    sessionAverageByID: {},
    prefillBySession: {},
  }
  const [version, setVersion] = createSignal(0)
  const [clock, setClock] = createSignal(Date.now())

  const bump = () => setVersion((v) => v + 1)

  const clearPrefillProgress = (sessionID: string) => {
    if (!tracker.prefillBySession[sessionID]) return
    delete tracker.prefillBySession[sessionID]
    bump()
  }

  const clearAllPrefill = () => {
    if (Object.keys(tracker.prefillBySession).length === 0) return
    for (const sessionID of Object.keys(tracker.prefillBySession)) {
      delete tracker.prefillBySession[sessionID]
    }
    bump()
  }

  const prunePrefill = () => {
    let changed = false

    for (const sessionID of Object.keys(tracker.prefillBySession)) {
      if (api.state.session.status(sessionID)?.type === "idle") {
        delete tracker.prefillBySession[sessionID]
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
      delete tracker.prefillBySession[sessionID]
      bump()
      return
    }

    if (
      prev
      && prev.total === next.total
      && prev.cache === next.cache
      && prev.processed === next.processed
      && prev.timeMs === next.timeMs
    ) {
      return
    }

    tracker.prefillBySession[sessionID] = next
    bump()
  }

  // WebSocket connection to the proxy's prefill push stream
  let ws: WebSocket | null = null
  let wsReconnectTimer: ReturnType<typeof setTimeout> | null = null
  let wsDisposed = false

  const scheduleReconnect = () => {
    if (wsDisposed || wsReconnectTimer) return
    wsReconnectTimer = setTimeout(() => {
      wsReconnectTimer = null
      connectWs()
    }, 2_000)
  }

  const connectWs = () => {
    if (wsDisposed) return
    log?.("ws: connecting")
    try {
      ws = new WebSocket(prefillWsUrl)
    } catch (err) {
      log?.("ws: failed to construct WebSocket:", err)
      scheduleReconnect()
      return
    }

    ws.onopen = () => {
      log?.("ws: connected")
    }

    ws.onmessage = (evt) => {
      try {
        const raw = typeof evt.data === "string" ? evt.data : String(evt.data)
        const msg = parseWsMessage(JSON.parse(raw) as unknown)
        if (!msg) return
        log?.("ws: message", msg)
        if (msg.done || !msg.started) {
          clearPrefillProgress(msg.sessionID)
        } else {
          setPrefillProgress(msg.sessionID, {
            sessionID: msg.sessionID,
            total: msg.total,
            cache: msg.cache,
            processed: msg.processed,
            timeMs: msg.timeMs,
            receivedAt: Date.now(),
          })
        }
      } catch (err) {
        log?.("ws: message parse error:", err)
      }
    }

    ws.onclose = (evt) => {
      log?.(`ws: closed (code=${evt.code})`)
      ws = null
      clearAllPrefill()
      scheduleReconnect()
    }

    ws.onerror = () => {
      log?.("ws: error (close will follow)")
    }
  }

  connectWs()

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
    if (evt.properties.info.role !== "assistant") return

    if (!evt.properties.info.time.completed) {
      const existing = tracker.messageTimingByID[evt.properties.info.id]
      log?.(`onMessage assistant incomplete: msgID=${evt.properties.info.id} existing=${!!existing}`)
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
    onDelta()
    onMessage()
    onPart()
    clearInterval(timer)
    wsDisposed = true
    if (wsReconnectTimer) {
      clearTimeout(wsReconnectTimer)
      wsReconnectTimer = null
    }
    ws?.close()
    ws = null
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
