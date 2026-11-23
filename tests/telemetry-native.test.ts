import { expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { run } from "../src/driver"

test("OpenCode's native provider exports generation spans and real wire usage", async () => {
  const home = await mkdtemp(join(tmpdir(), "at-opencode-trace-")), batches: any[] = []
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
    if (new URL(request.url).pathname === "/v1/traces") { batches.push(await request.json()); return Response.json({}) }
    const chunk = { id: "actual-request", model: "fixture", object: "chat.completion.chunk", choices: [
      { index: 0, delta: { role: "assistant", content: "Done" }, finish_reason: null } ] }
    const end = { ...chunk, choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 17, completion_tokens: 3, total_tokens: 20 } }
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(end)}\n\ndata: [DONE]\n\n`,
      { headers: { "content-type": "text/event-stream" } })
  } })
  const old = [process.env.AGENTTEAMS_OTEL_ENABLED, process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT]
  process.env.AGENTTEAMS_OTEL_ENABLED = "true"
  process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = server.url + "v1/traces"
  try {
    const result = await run({ home, directory: home, role: "worker", model: "fixture", baseURL: server.url + "v1",
      apiKey: "fixture-only", identity: {}, text: "PRIVATE INPUT", instructions: "Reply Done" },
    async (_, payload) => payload.operation === "schema" ? { description: "Task", inputSchema: { type: "object", properties: {} } } : {})
    const exported = batches.flatMap(b => b.resourceSpans).flatMap(r => r.scopeSpans).flatMap(s => s.spans)
    const models = exported.filter(s => s.name === "chat fixture")
    expect(models.length).toBeGreaterThan(0)
    expect(models.every(s => s.status.code !== 2)).toBe(true)
    expect(models.some(s => s.attributes.some((a: any) => a.key === "agentteams.request.kind" && a.value.stringValue === "title"))).toBe(false)
    expect(models.some(s => s.attributes.some((a: any) => a.key === "gen_ai.usage.input_tokens" && Number(a.value.intValue) === 17))).toBe(true)
    expect(JSON.stringify(exported)).toContain(result.session_id)
    expect(JSON.stringify(exported)).not.toContain("PRIVATE INPUT")
  } finally {
    for (const [index, key] of ["AGENTTEAMS_OTEL_ENABLED", "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT"].entries()) {
      if (old[index] === undefined) delete process.env[key]
      else process.env[key] = old[index]
    }
    server.stop(true)
    await rm(home, { recursive: true, force: true })
  }
}, 60000)

test("parallel real SDK reads expose queue time separately and inject instructions once per request", async () => {
  const home = await mkdtemp(join(tmpdir(), "at-opencode-read-timing-")), batches: any[] = [], requests: any[] = []
  await Promise.all([0, 1, 2, 3].map(i => writeFile(join(home, `${i}.txt`), "PRIVATE FILE CONTENT")))
  let step = 0
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
    if (new URL(request.url).pathname === "/v1/traces") { batches.push(await request.json()); return Response.json({}) }
    requests.push(await request.json())
    const first = step++ === 0
    const delta = first ? { tool_calls: [0, 1, 2, 3].map(i => ({ index: i, id: `read-${i}`, type: "function",
      function: { name: "read", arguments: JSON.stringify({ path: join(home, `${i}.txt`) }) } })) } : { content: "Done" }
    const chunk = { id: "read-timing", model: "fixture", object: "chat.completion.chunk", choices: [
      { index: 0, delta: { role: "assistant", ...delta }, finish_reason: null } ] }
    const end = { ...chunk, choices: [{ index: 0, delta: {}, finish_reason: first ? "tool_calls" : "stop" }],
      usage: { prompt_tokens: 17, completion_tokens: 3, total_tokens: 20 } }
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(end)}\n\ndata: [DONE]\n\n`,
      { headers: { "content-type": "text/event-stream" } })
  } })
  const old = [process.env.AGENTTEAMS_OTEL_ENABLED, process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT]
  process.env.AGENTTEAMS_OTEL_ENABLED = "true"
  process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = server.url + "v1/traces"
  let began = false
  try {
    await run({ home, directory: home, role: "worker", model: "fixture", baseURL: server.url + "v1",
      apiKey: "fixture-only", identity: { task_id: "timing-proof" }, text: "Read the four files.", instructions: "AT_INSTRUCTION_ONCE" },
    async (_, payload) => {
      if (payload.operation === "schema") return { description: "Task", inputSchema: { type: "object", properties: {} } }
      if (payload.action === "begin_tools") {
        if (!began) { began = true; await Bun.sleep(100) }
        return "operation"
      }
      return {}
    })
    const exported = batches.flatMap(b => b.resourceSpans).flatMap(r => r.scopeSpans).flatMap(s => s.spans)
    const tools = exported.filter(s => s.name === "read"), native = exported.filter(s => s.name === "opencode.native.read")
    const queues = exported.filter(s => s.name === "opencode.tool.queue")
    expect(tools).toHaveLength(4)
    expect(native).toHaveLength(4)
    expect(queues).toHaveLength(4)
    expect(native.every(s => s.status.code !== 2 && tools.some(t => t.spanId === s.parentSpanId))).toBe(true)
    const elapsed = (s: any) => (BigInt(s.endTimeUnixNano) - BigInt(s.startTimeUnixNano))
    expect(queues.some(s => elapsed(s) > 50000000n)).toBe(true)
    expect(exported.some(s => s.name === "opencode.rpc.recovery")).toBe(true)
    expect(requests).toHaveLength(2)
    for (const request of requests) expect(JSON.stringify(request.messages).split("AT_INSTRUCTION_ONCE")).toHaveLength(2)
    expect(JSON.stringify(exported)).not.toContain("PRIVATE FILE CONTENT")
  } finally {
    for (const [index, key] of ["AGENTTEAMS_OTEL_ENABLED", "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT"].entries()) {
      if (old[index] === undefined) delete process.env[key]
      else process.env[key] = old[index]
    }
    server.stop(true)
    await rm(home, { recursive: true, force: true })
  }
}, 60000)
