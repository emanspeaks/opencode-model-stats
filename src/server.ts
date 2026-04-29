import type { Plugin, PluginModule } from "@opencode-ai/plugin"

export type LlmRequestContext = {
  sessionID: string
  messageID: string
  providerID: string
  modelID: string
}

type OnRequestCallback = (ctx: LlmRequestContext) => Record<string, string> | Promise<Record<string, string>>

const callbacks = new Set<OnRequestCallback>()

function onRequest(callback: OnRequestCallback): () => void {
  callbacks.add(callback)
  return () => { callbacks.delete(callback) }
}

export const llm = { onRequest } as const

const server: Plugin = async (_input, options) => {
  const debug = options?.["debug"] === true

  const log = (...args: unknown[]) => console.log("[oc-tps]", ...args)

  if (debug) log("server plugin initialized, debug logging enabled")

  return {
    "chat.headers": async (input, output) => {
      const ctx: LlmRequestContext = {
        sessionID: input.sessionID,
        messageID: input.message.id,
        providerID: input.model.providerID,
        modelID: input.model.id,
      }

      if (debug) log("chat.headers: injecting base headers for", ctx)

      output.headers["x-opencode-session-id"] = ctx.sessionID
      output.headers["x-opencode-message-id"] = ctx.messageID

      if (callbacks.size === 0) {
        if (debug) log("chat.headers: no onRequest callbacks registered")
      } else {
        if (debug) log(`chat.headers: calling ${callbacks.size} onRequest callback(s)`)
        let i = 0
        for (const cb of callbacks) {
          i++
          try {
            const extra = await cb(ctx)
            if (debug) log(`chat.headers: callback ${i} returned`, extra)
            Object.assign(output.headers, extra)
          } catch (err) {
            console.warn("oc-tps: llm.onRequest callback threw, skipping:", err)
          }
        }
      }

      if (debug) log("chat.headers: final headers", output.headers)
    },
  }
}

type ServerModule = PluginModule & { id: string; llm: typeof llm }

const plugin: ServerModule = {
  id: "oc-tps",
  server,
  llm,
}

export default plugin
