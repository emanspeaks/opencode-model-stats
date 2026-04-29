/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { createMemo, createSignal } from "solid-js"

type StreamSample = {
  at: number
  tokens: number
}

const STREAM_WINDOW_MS = 5_000
const LIVE_STALE_MS = 1_500
const SINGLE_SAMPLE_MS = 1_000
const DEFAULT_PREFILL_PROGRESS_URL = "http://127.0.0.1:8080"
const DEFAULT_PREFILL_POLL_MS = 250

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
  lastToolCallAt?: number
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

type ProxyPrefillPayload = {
  found?: unknown
  total?: unknown
  cache?: unknown
  processed?: unknown
  time_ms?: unknown
  done?: unknown
}

function estimateStreamTokens(delta: string) {
  return Math.max(1, Math.ceil(Buffer.byteLength(delta, "utf8") / 5))
}

function formatRate(value: number, label: "TPS" | "AVG") {
  if (!Number.isFinite(value) || value <= 0) return undefined
  if (value >= 100) return `${Math.round(value)}${label === "TPS" ? " TPS" : ""}`
  if (value >= 10) return `${value.toFixed(1)}${label === "TPS" ? " TPS" : ""}`
  return `${value.toFixed(2)}${label === "TPS" ? " TPS" : ""}`
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

function findActiveTimingForSession(messageTimingByID: Record<string, MessageTiming>, sessionID: string): MessageTiming | undefined {
  let best: MessageTiming | undefined

  for (const timing of Object.values(messageTimingByID)) {
    if (timing.sessionID !== sessionID || timing.firstTokenAt) continue
    if (!best || timing.requestStartAt > best.requestStartAt) {
      best = timing
    }
  }

  return best
}

function parseProxyPrefill(value: unknown): { total: number; cache: number; processed: number; timeMs: number; done: boolean } | undefined {
  if (!value || typeof value !== "object") return undefined
  const data = value as ProxyPrefillPayload

  if (data.found !== true) return undefined
  if (
    !Number.isFinite(data.total)
    || !Number.isFinite(data.cache)
    || !Number.isFinite(data.processed)
    || !Number.isFinite(data.time_ms)
    || typeof data.total !== "number"
    || typeof data.cache !== "number"
    || typeof data.processed !== "number"
    || typeof data.time_ms !== "number"
  ) {
    return undefined
  }

  if (data.total <= 0 || data.cache < 0 || data.processed < 0 || data.time_ms < 0) return undefined
  if (data.processed > data.total && data.done !== true) return undefined

  return {
    total: data.total,
    cache: data.cache,
    processed: data.processed,
    timeMs: data.time_ms,
    done: data.done === true,
  }
}

function formatPrefillEta(prefill: PrefillProgress): string {
  const realProcessed = prefill.processed - prefill.cache
  const realTotal = prefill.total - prefill.cache
  if (realProcessed <= 0 || prefill.timeMs <= 0) return ""

  const realRatePerSec = realProcessed / (prefill.timeMs / 1000)
  if (!Number.isFinite(realRatePerSec) || realRatePerSec <= 0) return ""

  const remainingSec = (realTotal - realProcessed) / realRatePerSec
  if (!Number.isFinite(remainingSec) || remainingSec < 1) return ""
  if (remainingSec >= 60) return ` · ~${Math.floor(remainingSec / 60)}m left`
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
    return formatRate(totals.totalTokens / (totals.totalDurationMs / 1000), "AVG")
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
    return formatRate(total / durationSeconds, "AVG")
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

    const activeTiming = findActiveTimingForSession(props.tracker.messageTimingByID, props.sessionID)
    if (status?.type !== "idle" && activeTiming) {
      const elapsedSec = Math.max(0, Math.floor((Date.now() - activeTiming.requestStartAt) / 1000))
      return `Prefill ${elapsedSec}s`
    }

    const live = liveTps() ?? "-"
    const avg = sessionAverage() ?? "-"
    const ttft = sessionTtft() ?? "-"
    return `TPS ${live} | AVG ${avg} | TTFT ${ttft}`
  })

  return <>{text() ? <text fg={props.api.theme.current.textMuted}>{text()}</text> : null}</>
}

const tui: TuiPlugin = async (api, options) => {
  const prefillProgressUrl = (typeof options?.prefillProgressUrl === "string"
    ? options.prefillProgressUrl
    : DEFAULT_PREFILL_PROGRESS_URL) + "/prefill-progress"
  const prefillPollMs = (() => {
    const n = Number(options?.prefillPollMs)
    return Number.isFinite(n) && n > 0 ? Math.max(100, n) : DEFAULT_PREFILL_POLL_MS
  })()
  const tracker: TrackerState = {
    streamSamplesBySession: {},
    messageTimingByID: {},
    sessionAverageByID: {},
    prefillBySession: {},
  }
  const [version, setVersion] = createSignal(0)
  const [clock, setClock] = createSignal(Date.now())
  let prefillPollInFlight = false
  let loggedPrefillPollFailure = false

  const bump = () => setVersion((value) => value + 1)

  const clearPrefillProgress = (sessionID: string) => {
    if (!tracker.prefillBySession[sessionID]) return
    delete tracker.prefillBySession[sessionID]
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

  const activeSessionMessages = () => {
    const result: Record<string, { messageID: string; timing: MessageTiming }> = {}

    for (const [messageID, timing] of Object.entries(tracker.messageTimingByID)) {
      if (timing.firstTokenAt) continue
      const existing = result[timing.sessionID]
      if (!existing || timing.requestStartAt > existing.timing.requestStartAt) {
        result[timing.sessionID] = { messageID, timing }
      }
    }

    return result
  }

  const getPrefillUrlForSession = (sessionID: string): string => {
    const messages = api.state.session.messages(sessionID)
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]
      if (msg.role !== "user") continue
      const provider = api.state.provider.find((p) => p.id === msg.model.providerID)
      const model = provider?.models[msg.model.modelID]
      if (model?.api.url) {
        try {
          return new URL("/prefill-progress", model.api.url).toString()
        } catch {}
      }
      break
    }
    return prefillProgressUrl
  }

  const pollPrefillProgress = async () => {
    if (prefillPollInFlight) return
    prefillPollInFlight = true

    try {
      const active = activeSessionMessages()
      const activeSessionIDs = new Set(Object.keys(active))

      for (const sessionID of Object.keys(tracker.prefillBySession)) {
        if (!activeSessionIDs.has(sessionID) || api.state.session.status(sessionID)?.type === "idle") {
          setPrefillProgress(sessionID, undefined)
        }
      }

      for (const [sessionID, current] of Object.entries(active)) {
        if (api.state.session.status(sessionID)?.type === "idle") {
          setPrefillProgress(sessionID, undefined)
          continue
        }

        const url = new URL(getPrefillUrlForSession(sessionID))
        url.searchParams.set("session_id", sessionID)
        url.searchParams.set("message_id", current.messageID)

        const response = await fetch(url)
        if (!response.ok) {
          setPrefillProgress(sessionID, undefined)
          continue
        }

        const payload = parseProxyPrefill((await response.json()) as unknown)
        if (!payload) {
          setPrefillProgress(sessionID, undefined)
          continue
        }

        setPrefillProgress(sessionID, {
          sessionID,
          total: payload.total,
          cache: payload.cache,
          processed: payload.processed,
          timeMs: payload.timeMs,
          receivedAt: Date.now(),
        })
      }

      loggedPrefillPollFailure = false
    } catch {
      if (!loggedPrefillPollFailure) {
        console.warn("opencode-model-stats: prefill progress polling failed; using elapsed prefill fallback.")
        loggedPrefillPollFailure = true
      }
    } finally {
      prefillPollInFlight = false
    }
  }

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
      tracker.messageTimingByID[evt.properties.info.id] = {
        sessionID: evt.properties.sessionID,
        requestStartAt: evt.properties.info.time.created,
        firstResponseAt: existing?.firstResponseAt,
        firstTokenAt: existing?.firstTokenAt,
        lastTokenAt: existing?.lastTokenAt,
        lastToolCallAt: existing?.lastToolCallAt,
      }
      bump()
      return
    }

    clearPrefillProgress(evt.properties.sessionID)

    const timing = tracker.messageTimingByID[evt.properties.info.id]
    if (timing?.sessionID === evt.properties.sessionID && typeof timing.firstResponseAt === "number") {
      const totalTokens = evt.properties.info.tokens.output + evt.properties.info.tokens.reasoning
      const endAt =
        evt.properties.info.finish === "tool-calls"
          ? timing.lastToolCallAt
          : evt.properties.info.time.completed
      const durationMs = typeof endAt === "number" ? Math.max(endAt - timing.firstResponseAt, 1) : undefined
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
      return
    }
    if (evt.properties.part.state.status !== "running") return
    tracker.messageTimingByID[evt.properties.part.messageID] = {
      ...timing,
      lastToolCallAt: evt.properties.part.state.time.start,
    }
    bump()
  })

  const timer = setInterval(() => {
    setClock(Date.now())
    pruneSamples()
    prunePrefill()
    void pollPrefillProgress()
  }, prefillPollMs)

  api.lifecycle.onDispose(() => {
    onDelta()
    onMessage()
    onPart()
    clearInterval(timer)
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
