// Run inside the production image with --network none and a fresh native cache.
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { run } from "../src/driver"

const home = await mkdtemp(join(tmpdir(), "at-opencode-search-")), requests: any[] = []
await writeFile(join(home, "fixture.txt"), "HELLO_SEARCH_PROOF\n")
const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
  requests.push(await request.json())
  const first = requests.length === 1
  const delta = first ? { tool_calls: [
    { index: 0, id: "native-glob", type: "function", function: { name: "glob", arguments: JSON.stringify({ path: home, pattern: "*.txt" }) } },
    { index: 1, id: "native-grep", type: "function", function: { name: "grep", arguments: JSON.stringify({ path: home, pattern: "HELLO_SEARCH_PROOF" }) } },
  ] } : { content: "Done" }
  const chunk = { id: "search-proof", model: "fixture", object: "chat.completion.chunk", choices: [
    { index: 0, delta: { role: "assistant", ...delta }, finish_reason: null } ] }
  const end = { ...chunk, choices: [{ index: 0, delta: {}, finish_reason: first ? "tool_calls" : "stop" }] }
  return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(end)}\n\ndata: [DONE]\n\n`,
    { headers: { "content-type": "text/event-stream" } })
} })
try {
  const start = performance.now()
  await run({ home, directory: home, role: "worker", model: "fixture", baseURL: server.url + "v1",
    apiKey: "fixture-only", identity: {}, text: "Find the fixture file and matching line.", instructions: "Use glob and grep." },
  async (_, payload) => payload.operation === "schema" ? { description: "Task", inputSchema: { type: "object", properties: {} } } : {})
  const results = requests[1]?.messages.filter((m: any) => m.role === "tool") || []
  if (results.length !== 2 || results.some((m: any) => /timed out|error|failed|not available/i.test(JSON.stringify(m.content)))
      || !results.every((m: any) => JSON.stringify(m.content).includes("fixture.txt"))
      || !JSON.stringify(results).includes("HELLO_SEARCH_PROOF")) {
    console.error(JSON.stringify(results)) // This fixture contains only the public search proof.
    throw Error("Native search failed in the production image")
  }
  console.log(JSON.stringify({ passed: true, nativeTools: ["glob", "grep"], seconds: (performance.now() - start) / 1000 }))
} finally {
  server.stop(true)
  await rm(home, { recursive: true, force: true })
}
