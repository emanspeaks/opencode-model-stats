/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui"
import type { AssistantMessage } from "@opencode-ai/sdk/v2"
import { createMemo, createSignal } from "solid-js"

type StreamSample = {
  at: number
  tokens: number
}

const STREAM_WINDOW_MS = 15_000
const ACTIVE_GAP_MS = 1_250
const LIVE_STALE_MS = 1_500
const SINGLE_SAMPLE_MS = 1_000
const MAX_MESSAGE_SAMPLES = 4_096

type TrackerState = {
  streamSamplesBySession: Record<string, StreamSample[]>
  messageSamples: Record<string, StreamSample[]>
}

function estimateStreamTokens(delta: string) {
  return Math.max(1, Math.ceil(Buffer.byteLength(delta, "utf8") / 4))
}

function formatTps(value: number) {
  if (!Number.isFinite(value) || value <= 0) return undefined
  if (value >= 100) return `${Math.round(value)} TPS`
  if (value >= 10) return `${value.toFixed(1)} TPS`
  return `${value.toFixed(2)} TPS`
}

function activeDurationMs(samples: StreamSample[], tailAt?: number) {
  if (samples.length === 0) return 0
  if (samples.length === 1) {
    const tailDuration = tailAt ? Math.max(0, tailAt - samples[0].at) : SINGLE_SAMPLE_MS
    return Math.min(Math.max(tailDuration, 250), SINGLE_SAMPLE_MS)
  }

  let duration = 0
  for (let i = 1; i < samples.length; i++) {
    duration += Math.min(Math.max(0, samples[i].at - samples[i - 1].at), ACTIVE_GAP_MS)
  }

  if (tailAt) {
    duration += Math.min(Math.max(0, tailAt - samples[samples.length - 1].at), ACTIVE_GAP_MS)
  }

  return Math.max(duration, SINGLE_SAMPLE_MS)
}

function SessionPromptRight(props: {
  api: Parameters<TuiPlugin>[0]
  sessionID: string
  tracker: TrackerState
  version: () => number
  clock: () => number
}) {
  const sessionMessages = createMemo(() => props.api.state.session.messages(props.sessionID))

  const finalTps = createMemo(() => {
    props.version()
    const last = sessionMessages().findLast(
      (item): item is AssistantMessage => item.role === "assistant" && item.tokens.output > 0,
    )
    if (!last) return undefined

    const user = sessionMessages().find((item) => item.role === "user" && item.id === last.parentID)
    const start = user?.time.created ?? last.time.created
    const end = last.time.completed ?? last.time.created
    const sampleWindow = props.tracker.messageSamples[last.id] ?? []
    const activeMs = activeDurationMs(sampleWindow)
    const wallMs = end > start ? end - start : 0
    const durationSeconds = (activeMs > 0 ? activeMs : wallMs) / 1000
    if (durationSeconds <= 0) return undefined
    return formatTps(last.tokens.output / durationSeconds)
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
    return formatTps(total / durationSeconds)
  })

  const text = createMemo(() => {
    const live = liveTps()
    if (live) return `~${live}`
    return finalTps()
  })

  return <>{text() ? <text fg={props.api.theme.current.textMuted}>{text()}</text> : null}</>
}

const tui: TuiPlugin = async (api) => {
  const tracker: TrackerState = {
    streamSamplesBySession: {},
    messageSamples: {},
  }
  const [version, setVersion] = createSignal(0)
  const [clock, setClock] = createSignal(Date.now())

  const bump = () => setVersion((value) => value + 1)

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

  const appendSample = (sessionID: string, messageID: string, sample: StreamSample) => {
    const now = sample.at
    tracker.streamSamplesBySession[sessionID] = [
      ...(tracker.streamSamplesBySession[sessionID] ?? []).filter((item) => now - item.at <= STREAM_WINDOW_MS),
      sample,
    ]
    tracker.messageSamples[messageID] = [...(tracker.messageSamples[messageID] ?? []), sample].slice(-MAX_MESSAGE_SAMPLES)
    bump()
  }

  const onDelta = api.event.on("message.part.delta", (evt) => {
    if (evt.properties.field !== "text") return
    const parts = api.state.part(evt.properties.messageID)
    const part = parts.find((item) => item.id === evt.properties.partID)
    if (!part) return
    if (part.type !== "text" && part.type !== "reasoning") return
    appendSample(evt.properties.sessionID, evt.properties.messageID, {
      at: Date.now(),
      tokens: estimateStreamTokens(evt.properties.delta),
    })
  })

  const onMessage = api.event.on("message.updated", (evt) => {
    if (evt.properties.info.role !== "assistant") return
    if (!evt.properties.info.time.completed) return
    pruneSamples(evt.properties.info.time.completed)
    bump()
  })

  const timer = setInterval(() => {
    setClock(Date.now())
    pruneSamples()
  }, 1000)

  api.lifecycle.onDispose(() => {
    onDelta()
    onMessage()
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
  id: "oc-tps",
  tui,
}

export default plugin
