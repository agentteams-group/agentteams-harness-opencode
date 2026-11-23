import { expect, test } from "bun:test"
import { telemetry } from "../src/telemetry"

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
    const native = { modelId: "actual-model", async doStream() {
      return { stream: new ReadableStream({ start(controller) {
        controller.enqueue({ type: "text-delta", delta: "PRIVATE CONTENT" })
        controller.enqueue({ type: "finish", usage: { inputTokens: { total: 7 }, outputTokens: { total: 3 } } })
        controller.close()
      } }) }
    } }
    const result = await spans.language(native).doStream({ prompt: "PRIVATE CONTENT" })
    for await (const _ of result.stream) { /* Consume the real stream. */ }
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
