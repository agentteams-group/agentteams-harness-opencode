import { describe, expect, test } from "bun:test"
import { Guard, prepare, type Rpc } from "../src/protocol"

function fixture() {
  const calls: any[] = []
  const rpc: Rpc = async (method, payload) => {
    calls.push({ method, ...payload })
    if (payload.operation === "schema") return { description: "Task", inputSchema: { type: "object" } }
    if (payload.operation === "prepare_event") return { execution: "node-1", context: { outputDirectory: "/output", scratchDirectory: "/scratch" } }
    if (payload.operation === "admit_event") return { active: true, pending_task_ids: ["main-1"] }
    if (payload.operation === "sources") return []
    if (payload.action?.endsWith("begin_tools")) return "operation-1"
    if (payload.action === "write_path") return payload.path.startsWith("/output/") || payload.path.startsWith("/scratch/")
    return {}
  }
  return { rpc, calls }
}

describe("native Task and execution boundaries", () => {
  test("Leader uses the verified phase and public role schema", async () => {
    const { rpc, calls } = fixture()
    const state = await prepare({ role: "team_leader", event: { event_id: "$handoff", meta: {
      teamharness_coordination: { id: "verified", kind: "handoff" },
    } } }, rpc)
    expect(state.context.role).toBe("leader")
    expect(calls.find(c => c.operation === "admit_event").nativeEventId).toBe("$handoff")
    expect(calls.find(c => c.operation === "prepare_event").event.pending_task_ids).toEqual(["main-1"])
  })

  test("rejects a write outside the prepared Task directories before journaling", async () => {
    const { rpc, calls } = fixture()
    const guard = new Guard(rpc, { task_id: "node-1" }, { execution: "node-1", context: {
      outputDirectory: "/output", scratchDirectory: "/scratch",
    } })
    await expect(guard.execute("write", "call-1", { path: "/other/file" }, async () => "written")).rejects.toThrow()
    expect(calls.some(c => c.action === "begin_tools")).toBe(false)
  })

  test("persists admission before the native effect and associates the original call ID", async () => {
    const { rpc, calls } = fixture()
    const guard = new Guard(rpc, { task_id: "node-1" }, {})
    await guard.execute("read", "call-1", {}, async () => {
      expect(calls.at(-1).action).toBe("begin_tools")
      return { content: "bytes" }
    }, true)
    const finish = calls.find(c => c.action === "finish_tools")
    expect(finish.operation_id).toBe("operation-1")
    expect(finish.results[0].id).toBe("call-1")
  })

  test("leaves a failed mutating tool unconfirmed and fences subsequent tools", async () => {
    const { rpc, calls } = fixture()
    const guard = new Guard(rpc, { task_id: "node-1" }, {})
    await expect(guard.execute("shell", "call-1", {}, async () => { throw Error("lost result") })).rejects.toThrow()
    await expect(guard.execute("read", "call-2", {}, async () => "read")).rejects.toThrow()
    expect(calls.some(c => c.action === "finish_tools")).toBe(false)
  })

  test("records a known read-only error without declaring an unknown write harmless", async () => {
    const { rpc, calls } = fixture()
    const guard = new Guard(rpc, { event_key: "message-1" }, {})
    await expect(guard.execute("read", "call-1", {}, async () => { throw Error("missing") }, true)).rejects.toThrow()
    expect(calls.find(c => c.action === "matrix.message.finish_tools").results[0].content.effect).toBe("none")
  })

  test("serializes parallel native tools across admission and receipts", async () => {
    const { rpc, calls } = fixture()
    const guard = new Guard(rpc, { task_id: "node-1" }, {})
    await Promise.all([1, 2].map(i => guard.execute("read", `call-${i}`, {}, async () => {
      await new Promise(resolve => setTimeout(resolve, 10))
      return "ok"
    }, true)))
    expect(calls.filter(c => /begin_tools|finish_tools/.test(c.action)).map(c => c.action)).toEqual([
      "begin_tools", "finish_tools", "begin_tools", "finish_tools",
    ])
  })
})
