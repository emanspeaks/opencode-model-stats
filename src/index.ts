import tuiPlugin from "./tui"
import serverPlugin from "./server"

export type { LlmRequestContext } from "./server"
export { llm } from "./server"

export default {
  id: "oc-tps",
  tui: tuiPlugin.tui,
  server: serverPlugin.server,
  llm: serverPlugin.llm,
}
