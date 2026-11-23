import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
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
