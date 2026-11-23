import { expect, test } from "bun:test"
import { telemetry } from "../src/telemetry"
import { Guard } from "../src/protocol"

test("exports actual streaming usage and tool outcomes without input content", async () => {
  const batches: any[] = []
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
    batches.push(await request.json())
    return Response.json({})
  } })
  const old = { enabled: process.env.AGENTTEAMS_OTEL_ENABLED, endpoint: process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT }
  process.env.AGENTTEAMS_OTEL_ENABLED = "true"
  process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = server.url + "v1/traces"
  try {
    const spans = telemetry({ "agentteams.worker.name": "worker-proof", "agentteams.runtime": "opencode",
      "agentteams.task.id": "task-proof" })!
    spans.session("native-session")
    const request = new Request("http://model.invalid/chat/completions")
    spans.request(request, "actual-model", "primary")
    const result = spans.response(request, new Response('data: {"content":"PRIVATE CONTENT"}\n\ndata: {"usage":{"prompt_tokens":7,"completion_tokens":3}}\n\ndata: [DONE]\n\n',
      { headers: { "content-type": "text/event-stream" } }))
    await result.text()
    expect(await spans.tool("write", "native-call", async () => "PRIVATE CONTENT")).toBe("PRIVATE CONTENT")
    await expect(spans.tool("shell", "failed-call", async () => { throw Error("PRIVATE CONTENT") })).rejects.toThrow()
    await spans.close()
    const encoded = JSON.stringify(batches)
    expect(encoded).not.toContain("PRIVATE CONTENT")
    expect(encoded).toContain("gen_ai.usage.input_tokens")
    expect(encoded).toContain("native-call")
    expect(encoded).toContain("task:task-proof")
    const exported = batches.flatMap(b => b.resourceSpans).flatMap(r => r.scopeSpans).flatMap(s => s.spans)
    expect(exported).toHaveLength(4)
    expect(exported.find(s => s.name === "shell").status.code).toBe(2)
  } finally {
    if (old.enabled === undefined) delete process.env.AGENTTEAMS_OTEL_ENABLED
    else process.env.AGENTTEAMS_OTEL_ENABLED = old.enabled
    if (old.endpoint === undefined) delete process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
    else process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = old.endpoint
    server.stop(true)
  }
})

test("separates queued admission, bridge RPC and native execution under the original tool span", async () => {
  const batches: any[] = []
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
    batches.push(await request.json())
    return Response.json({})
  } })
  const old = [process.env.AGENTTEAMS_OTEL_ENABLED, process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT]
  process.env.AGENTTEAMS_OTEL_ENABLED = "true"
  process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = server.url + "v1/traces"
  let release!: () => void
  const first = new Promise<void>(resolve => { release = resolve })
  const order: string[] = []
  try {
    const spans = telemetry({ "agentteams.task.id": "timing-proof" })!
    const guard = new Guard(async (_, payload) => spans.step("opencode.rpc.recovery",
      { "agentteams.rpc.operation": payload.action }, async () => payload.action === "begin_tools" ? "operation" : {}),
    { task_id: "timing-proof" }, {}, (name, execute) => spans.step(name, {}, execute))
    const execute = (id: string) => spans.tool("read", id, () => guard.execute("read", id, {},
      () => spans.step("opencode.native.read", {}, async () => {
        order.push(id)
        if (id === "first") await first
        return "PRIVATE FILE BYTES"
      }), true))
    const running = [execute("first"), execute("second")]
    await Bun.sleep(20)
    expect(order).toEqual(["first"])
    release()
    await Promise.all(running)
    await spans.close()
    const exported = batches.flatMap(b => b.resourceSpans).flatMap(r => r.scopeSpans).flatMap(s => s.spans)
    const tools = exported.filter(s => s.name === "read")
    const queues = exported.filter(s => s.name === "opencode.tool.queue")
    const native = exported.filter(s => s.name === "opencode.native.read")
    const rpc = exported.filter(s => s.name === "opencode.rpc.recovery")
    expect(tools).toHaveLength(2)
    expect(queues).toHaveLength(2)
    expect(native).toHaveLength(2)
    expect(rpc).toHaveLength(6)
    expect([...queues, ...native, ...rpc].every(s => tools.some(t => t.spanId === s.parentSpanId))).toBe(true)
    expect(JSON.stringify(exported)).not.toContain("PRIVATE FILE BYTES")
    expect(order).toEqual(["first", "second"])
  } finally {
    release()
    for (const [index, key] of ["AGENTTEAMS_OTEL_ENABLED", "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT"].entries()) {
      if (old[index] === undefined) delete process.env[key]
      else process.env[key] = old[index]
    }
    server.stop(true)
  }
})
