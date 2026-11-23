import { Plugin } from "@opencode/plugin"
import { Guard, type Rpc } from "./protocol"
import type { Telemetry } from "./telemetry"

export const TASK = "agentteams_task"
const FILE_TOOLS = new Set(["read", "write", "edit", "glob", "grep", "shell", "skill"])
const READ_ONLY = new Set(["read", "glob", "grep", "skill"])

export type Binding = {
  sessionID: string
  host: any
  phaseComplete: boolean
  receipts: string[]
}

// The SDK's shell detaches after its first wait. Keep that original native
// invocation open through its terminal shell state before committing a receipt.
export async function settleShell(host: any, result: any, directory: string, signal: AbortSignal) {
  const id = result.output?.shellID || result.metadata?.shellID
  if (!id) return result
  const location = { directory }
  while (true) {
    if (signal.aborted) {
      await host.shell.remove({ id, location })
      throw Error("Native shell interrupted; verify the outstanding operation")
    }
    const { data: shell } = await host.shell.get({ id, location })
    if (shell.status !== "running") {
      if (shell.status !== "exited") throw Error("Native shell has no confirmed exit")
      const { data: output } = await host.shell.output({ id, location })
      return { output: { ...output, exitCode: shell.exit, signal: shell.signal },
        content: [{ type: "text", text: output.output }], metadata: { status: "completed" } }
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
}

export function createPlugin(options: {
  rpc: Rpc; context: Record<string, any>; schema: any; identity: Record<string, any>
  instructions: string; directory: string; binding: Binding
  beforeModel?: (sessionID: string) => Promise<void>
  telemetry?: Telemetry
}) {
  const { rpc, context, schema, identity, instructions, directory, binding } = options
  const measure = <T>(name: string, execute: () => Promise<T>) => options.telemetry
    ? options.telemetry.step(name, {}, execute) : execute()
  const guard = new Guard(rpc, identity, context, options.telemetry ? measure : undefined)
  const coordinator = Boolean(context.planning || context.review || context.completion)
  return Plugin.define({
    id: "agentteams.opencode",
    async setup(ctx) {
      // A managed phase needs no auxiliary inference outside input admission.
      await ctx.session.hook("title", event => {
        event.result = "AgentTeams " + (context.execution || context.completion || context.planning?.[0] || context.role)
      })
      await ctx.session.hook("http.request", event => {
        options.telemetry?.request(event.request, event.model.id, event.kind)
      })
      await ctx.session.hook("http.response", event => {
        if (options.telemetry) event.response = options.telemetry.response(event.request, event.response)
      })
      await ctx.tool.transform(editor => {
        for (const definition of editor.list()) {
          if (coordinator || !FILE_TOOLS.has(definition.id)) {
            editor.remove(definition.id)
            continue
          }
          // Bind the actual SDK executor in this registration, independently
          // of model arguments and names supplied in a tool call.
          const execute = definition.execute
          editor.update(definition.id, tool => {
            tool.options = { ...tool.options, codemode: false }
            tool.execute = async (input, native) => {
              if (native.sessionID !== binding.sessionID) throw Error("Unbound native session")
              const executeGuarded = () => guard.execute(definition.id, native.id, input, async () => {
                const final = await measure("opencode.native." + definition.id, async () => {
                  const result = await execute(input, native)
                  return definition.id === "shell"
                    ? measure("opencode.native.shell.wait", () => settleShell(binding.host, result, directory, native.signal)) : result
                })
                if (context.execution && !READ_ONLY.has(definition.id)) {
                  const files = await rpc("recovery", { action: "persist_outputs", identity,
                    output: context.context.outputDirectory, scratch: context.context.scratchDirectory })
                  return { ...final, metadata: { ...final.metadata, agentteams_files: files } }
                }
                return final
              }, READ_ONLY.has(definition.id))
              return options.telemetry ? options.telemetry.tool(definition.id, native.id, executeGuarded) : executeGuarded()
            }
          })
        }
        editor.add({
          name: TASK, description: schema.description, input: schema.inputSchema,
          options: { codemode: false },
          execute: async (arguments_, native) => {
            const executeGuarded = () => guard.serial(async () => {
            if (native.sessionID !== binding.sessionID || binding.phaseComplete) throw Error("Inactive Task phase")
            await guard.admit()
            const response = await rpc("task", { operation: "task", arguments: arguments_, context })
            Object.assign(context, response.contextUpdate || {})
            if (response.requiresInputCheckpoint) throw Error("Worker/Leader received an unexpected Human input refresh")
            if (response.fact) binding.receipts.push(response.fact)
            if (response.phaseComplete) binding.phaseComplete = true
            return { content: JSON.stringify(response.result ?? response) }
            })
            return options.telemetry ? options.telemetry.tool(TASK, native.id, executeGuarded) : executeGuarded()
          },
        })
      })
      const inject = async (event: any) => {
        if (event.sessionID !== binding.sessionID) throw Error("Unbound native model context")
        await options.beforeModel?.(event.sessionID)
        const admission = binding.phaseComplete
          ? await rpc("recovery", { action: identity.event_key ? "matrix.message.owned" : "current", identity })
          : await guard.admit()
        event.system.push({ type: "text", text: [instructions,
          `Use the registered native tool ${TASK} for Task operations.`, context.fact,
          JSON.stringify(context.context || {}),
          context.roster ? "Registered team identities: " + JSON.stringify(context.roster) : "",
          JSON.stringify(admission.receipts || []), ...binding.receipts,
        ].filter(Boolean).join("\n\n") })
        if (binding.phaseComplete) {
          event.tools = {}
          event.system.push({ type: "text", text: "Your Task phase is complete. End this turn without further actions." })
        }
      }
      await ctx.session.hook("context", inject)
      await ctx.session.hook("compaction", inject)
      // A headless process cannot leave an invisible native approval pending.
      // Allowed actions still follow the Controller-projected launch policy.
      await ctx.permission.hook("evaluate", event => {
        if (event.effect === "ask") {
          event.effect = "deny"
          event.message = "This headless Harness requires an explicit launch policy for this action"
        }
      })
    },
  })
}
