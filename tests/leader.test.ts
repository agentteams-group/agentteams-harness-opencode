import { test, expect } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { run } from "../src/driver"
import type { Rpc } from "../src/protocol"

test("real OpenCode Leader plans the admitted main Task with only the public tool", async () => {
  const home = await mkdtemp(join(tmpdir(), "at-opencode-leader-"))
  let planned = false
  const rpc: Rpc = async (_, payload) => {
    if (payload.operation === "admit_event") {
      expect(payload.nativeEventId).toBe("$handoff")
      return { active: true, pending_task_ids: ["main-1"] }
    }
    if (payload.operation === "prepare_event") return { planning: payload.event.pending_task_ids }
    if (payload.operation === "roster") return { workers: ["worker-1"] }
    if (payload.operation === "schema") return { description: "Plan your public Task", inputSchema: {
      type: "object", properties: { action: { type: "string" }, taskId: { type: "string" } },
      required: ["action", "taskId"], additionalProperties: false,
    } }
    if (payload.operation === "task") {
      expect(payload.context.role).toBe("leader")
      expect(payload.context.planning).toEqual(["main-1"])
      expect(payload.arguments).toEqual({ action: "plan", taskId: "main-1" })
      planned = true
      return { result: { ok: true }, phaseComplete: true, fact: "Plan saved" }
    }
    return {}
  }
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    const body = await req.json() as any
    const primary = body.tools?.length > 0
    if (primary) expect(body.tools.map((t: any) => t.function.name)).toEqual(["agentteams_task"])
    const delta = primary ? { tool_calls: [{ index: 0, id: "plan-1", type: "function", function: {
      name: "agentteams_task", arguments: JSON.stringify({ action: "plan", taskId: "main-1" }),
    } }] } : { content: "Done" }
    const data = { id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [
      { index: 0, delta: { role: "assistant", ...delta }, finish_reason: null },
    ] }
    return new Response(`data: ${JSON.stringify(data)}\n\ndata: ${JSON.stringify({ ...data, choices: [
      { index: 0, delta: {}, finish_reason: primary ? "tool_calls" : "stop" },
    ] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } })
  } })
  try {
    const result = await run({ home, directory: home, role: "team_leader", team: "team-1", model: "fixture",
      baseURL: server.url + "v1", apiKey: "fixture-only", identity: { event_key: "source-1" },
      text: "Plan this request using registered Workers.", instructions: "You coordinate this Team.",
      event: { event_id: "$handoff", meta: { teamharness_coordination: { id: "phase-1", kind: "handoff" } } },
    }, rpc)
    expect(planned).toBe(true)
    expect(result.phaseComplete).toBe(true)
  } finally {
    server.stop(true)
    await rm(home, { recursive: true, force: true })
  }
}, 60000)
