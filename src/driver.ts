import { OpenCode } from "@opencode/sdk"
import { createHash } from "node:crypto"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { createPlugin, type Binding } from "./plugin"
import { prepare, type Rpc, type Frame } from "./protocol"
import { telemetry } from "./telemetry"

export const nativeRpc: Rpc = async (method, payload) => {
  const child = Bun.spawn([process.env.TEAMHARNESS_PYTHON || "python3", "-m", "agentteams_opencode.rpc"], {
    stdin: new Blob([JSON.stringify({ method, payload })]), stdout: "pipe", stderr: "inherit",
  })
  const [text, code] = await Promise.all([new Response(child.stdout).text(), child.exited])
  const result = JSON.parse(text)
  if (code !== 0 || result.error) throw Error(result.error || "Native bridge failed")
  return result.value
}

export type Request = Frame & {
  home: string; directory: string; model: string; baseURL: string; apiKey: string
  identity: Record<string, any>; text: string; instructions: string
  sources?: Array<{ key: string; snapshot: any }>
  allowShell?: boolean
}

export async function run(request: Request, rpc: Rpc = nativeRpc, check = false) {
  const prepared = check ? { context: { role: request.role }, schema: {
    description: "AgentTeams Task", inputSchema: { type: "object", properties: {} },
  } } : await prepare(request, rpc)
  const context: Record<string, any> = prepared.context
  if (context.execution) await rpc("recovery", { action: "restore_outputs", identity: request.identity,
    output: context.context.outputDirectory, scratch: context.context.scratchDirectory })
  const directory = context.execution ? context.context.outputDirectory : request.directory
  await mkdir(directory, { recursive: true })
  const nativeRoot = join(request.home, ".opencode")
  await mkdir(nativeRoot, { recursive: true })
  const inputID = "msg_" + createHash("sha256").update(request.text).digest("hex")
  const text = [request.text, ...(request.sources || []).map(source =>
    "Trusted Matrix input:\n" + JSON.stringify(source.snapshot.input))].join("\n\n")
  const binding: Binding = { sessionID: "", host: undefined, phaseComplete: false, receipts: [] }
  let committed = false
  const spans = check ? undefined : telemetry({ "agentteams.worker.name": process.env.AGENTTEAMS_WORKER_NAME || "",
    "agentteams.runtime": "opencode", "agentteams.role": request.role,
    "agentteams.task.id": request.identity.task_id || context.execution || context.completion || context.review?.[0] || context.planning?.[0] || "",
    "agentteams.team.id": request.identity.team_id || request.team || "",
    "agentteams.room.id": request.event?.room_id || "", "agentteams.event.id": request.event?.event_id || "" })
  const plugin = createPlugin({ rpc, context, schema: prepared.schema, identity: request.identity,
    telemetry: spans,
    instructions: request.instructions, directory, binding,
    async beforeModel(sessionID) {
      if (committed) return
      const row = await binding.host.session.message.get({ sessionID, messageID: inputID })
      if (row.type !== "user" || row.text !== text) throw Error("Native User input was not durably admitted")
      const digest = createHash("sha256").update(JSON.stringify(row)).digest("hex")
      for (const source of request.sources || []) {
        await rpc("recovery", { action: "matrix.native.commit", event_key: source.key,
          snapshot: source.snapshot, native_ref: sessionID + ":" + inputID, native_digest: digest })
      }
      committed = true
    },
  })
  // Disable project-level configuration so a task checkout cannot replace
  // the trusted AT plugin or install untracked execution paths.
  const config = {
    providers: { "agentteams-gateway": { name: "AgentTeams gateway",
      package: "@opencode/ai/providers/openai-compatible", activation: "enabled",
      settings: { baseURL: request.baseURL, apiKey: request.apiKey },
      models: { [request.model]: { name: request.model } },
    } },
    skills: [join(request.home, "skills")],
    permissions: [
      { action: "read", resource: "*", effect: "allow" },
      { action: "edit", resource: "*", effect: "allow" },
      { action: "skill", resource: "*", effect: "allow" },
      { action: "shell", resource: "*", effect: request.allowShell ? "allow" : "deny" },
      { action: "execute", resource: "*", effect: "deny" },
      { action: "subagent", resource: "*", effect: "deny" },
    ],
  }
  const host = await OpenCode.create({ database: { path: join(nativeRoot, "sessions.sqlite") },
    config: { directory: nativeRoot, project: false, claude: false, content: JSON.stringify(config) },
    models: { fetch: false }, fs: { filewatcher: false }, plugins: [plugin] })
  binding.host = host
  let failed: unknown
  try {
    const session = await host.sessions.create({ location: { directory }, agent: "build",
      model: { providerID: "agentteams-gateway", id: request.model } })
    binding.sessionID = session.id
    spans?.session(session.id)
    if (check) return { session_id: session.id, answer: "", phaseComplete: false }
    const interrupt = () => { void host.sessions.interrupt({ sessionID: session.id, resume: false }) }
    process.once("SIGTERM", interrupt)
    process.once("SIGINT", interrupt)
    try {
      await host.sessions.prompt({ sessionID: session.id, id: inputID, text,
        metadata: { "agentteams.event_id": request.event?.event_id || "task-recovery" } })
      await host.experimental.session.wait({ sessionID: session.id })
      const messages = await host.sessions.context({ sessionID: session.id })
      const idle = messages.findLast(message => message.type === "idle")
      if (idle?.type === "idle" && idle.outcome !== "succeeded") {
        throw Error("Native turn failed: " + (idle.error?.type || idle.outcome))
      }
      const answer = messages.filter(message => message.type === "assistant").flatMap(message =>
        message.content.filter(part => part.type === "text").map(part => part.text)).join("\n")
      if (!committed) throw Error("The native turn did not admit its input")
      return { answer, session_id: session.id, phaseComplete: binding.phaseComplete }
    } finally {
      process.removeListener("SIGTERM", interrupt)
      process.removeListener("SIGINT", interrupt)
    }
  } catch (error) {
    failed = error
    throw error
  } finally {
    await host.close()
    await spans?.close(failed)
  }
}

if (import.meta.main) {
  try {
    const request = JSON.parse(await Bun.stdin.text())
    process.stdout.write(JSON.stringify(await run(request, nativeRpc, process.argv.includes("--check"))) + "\n")
  } catch (error) {
    // Request bodies and credentials stay out of the managed log stream.
    console.error("OpenCode native turn failed:", error instanceof Error ? error.name : "Error")
    process.exitCode = 1
  }
}
