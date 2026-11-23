import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { run } from "../src/driver"
import type { Rpc } from "../src/protocol"

test.each(["write", "shell"])("real OpenCode SDK admits input and completes native %s before public Task submission", async (tool) => {
  const home = await mkdtemp(join(tmpdir(), "at-opencode-native-"))
  const output = join(home, "tasks/node-1/output")
  await mkdir(output, { recursive: true })
  const calls: any[] = [], requests: any[] = []
  let modelStep = 0, committed = false
  const rpc: Rpc = async (method, payload) => {
    calls.push({ method, ...payload })
    if (payload.operation === "prepare_event") return { execution: "node-1", context: {
      outputDirectory: output, scratchDirectory: join(home, "scratch"),
    } }
    if (payload.operation === "schema") return { description: "Operate on your public Task", inputSchema: {
      type: "object", properties: { action: { type: "string", enum: ["submit"] }, taskId: { type: "string" }, summary: { type: "string" } },
      required: ["action", "taskId", "summary"], additionalProperties: false,
    } }
    if (payload.action === "matrix.native.commit") { committed = true; return {} }
    if (payload.action === "write_path") return payload.path === join(output, "result.txt")
    if (payload.action === "begin_tools") {
      expect(await Bun.file(join(output, "result.txt")).exists()).toBe(false)
      return "op-write"
    }
    if (payload.operation === "task") {
      expect(payload.context.execution).toBe("node-1")
      expect(await readFile(join(output, "result.txt"), "utf8")).toBe("verified bytes")
      return { result: { ok: true, submissionId: "candidate-1" }, phaseComplete: true, fact: "Candidate saved" }
    }
    return {}
  }
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    const body = await req.json() as any
    requests.push(body)
    // Native title generation is auxiliary and must not execute business tools.
    const primary = body.tools?.length > 0
    if (primary) expect(committed).toBe(true)
    const step = primary ? modelStep++ : 99
    const delta = step === 0 ? { tool_calls: [{ index: 0, id: "native-write", type: "function", function: {
      name: tool, arguments: JSON.stringify(tool === "write"
        ? { path: join(output, "result.txt"), content: "verified bytes" }
        : { command: "sleep 0.3; printf 'verified bytes' > result.txt", timeout: 10 }),
    } }] } : step === 1 ? { tool_calls: [{ index: 0, id: "native-submit", type: "function", function: {
      name: "agentteams_task", arguments: JSON.stringify({ action: "submit", taskId: "node-1", summary: "Saved output" }),
    } }] } : { content: "Done" }
    const chunk = { id: "completion-test", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [
      { index: 0, delta: { role: "assistant", ...delta }, finish_reason: null },
    ] }
    const end = { ...chunk, choices: [{ index: 0, delta: {}, finish_reason: step < 2 ? "tool_calls" : "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(end)}\n\ndata: [DONE]\n\n`, {
      headers: { "content-type": "text/event-stream" },
    })
  } })
  try {
    const result = await run({ home, directory: home, role: "worker", model: "fixture",
      baseURL: server.url + "v1", apiKey: "fixture-only", identity: { task_id: "node-1" },
      text: "Write the requested output, then submit.", instructions: "Use the native tools.",
      allowShell: true,
      event: { event_id: "$assigned", meta: { teamharness_coordination: { kind: "task_assigned" } } },
      sources: [{ key: "source-1", snapshot: { input: { event_id: "$assigned" } } }],
    }, rpc)
    expect(result.phaseComplete).toBe(true)
    expect(calls.find(c => c.action === "finish_tools").results[0].id).toBe("native-write")
    const tools = requests.find(r => r.tools?.length).tools.map((t: any) => t.function.name)
    expect(tools).toContain("agentteams_task")
    expect(tools).not.toContain("subagent")
    expect(tools).not.toContain("execute")
  } finally {
    server.stop(true)
    await rm(home, { recursive: true, force: true })
  }
}, 60000)
