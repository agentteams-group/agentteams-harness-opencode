import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { run } from "../src/driver"

test("native provider failure must not become a successful empty reply", async () => {
  const home = await mkdtemp(join(tmpdir(), "at-opencode-auth-"))
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch() {
    return Response.json({ error: { message: "Invalid fixture key", type: "invalid_request_error", code: "invalid_api_key" } }, { status: 401 })
  } })
  try {
    await expect(run({ home, directory: home, role: "worker", model: "fixture", baseURL: server.url + "v1",
      apiKey: "fixture-only", identity: {}, text: "Write a file", instructions: "Use native tools" },
    async (_, payload) => payload.operation === "schema" ? { description: "Task", inputSchema: { type: "object", properties: {} } } : {}))
      .rejects.toThrow("Native turn failed: provider.auth")
  } finally {
    server.stop(true)
    await rm(home, { recursive: true, force: true })
  }
}, 60000)
