export type Rpc = (method: "task" | "recovery", payload: Record<string, any>) => Promise<any>
export type Frame = {
  role: string
  team?: string
  event?: { event_id: string; room_id?: string; sender?: string; meta?: Record<string, any> }
}

export async function prepare(frame: Frame, rpc: Rpc) {
  const role = frame.role === "team_leader" ? "leader" : frame.role
  if (!["leader", "worker"].includes(role)) throw Error("This Harness supports Worker and Leader roles")
  const event = frame.event
  const context: Record<string, any> = { role, sourceEvent: event?.event_id, sources: [] }
  const notification = event?.meta?.teamharness_coordination
  if (notification) {
    const current = { ...notification }
    if (["handoff", "task_submitted", "main_task_ready"].includes(current.kind)) {
      const phase = await rpc("task", { operation: "admit_event", eventId: current.id, nativeEventId: event!.event_id })
      if (phase.active !== true) throw Error("Coordination phase is not active")
      if (current.kind === "handoff") current.pending_task_ids = phase.pending_task_ids
    }
    const result = await rpc("task", { operation: "prepare_event", event: current })
    if (result.ok === false) throw Error("Public Task preparation failed")
    Object.assign(context, result)
  } else if (event?.event_id.startsWith("$")) {
    context.sources = await rpc("task", { operation: "sources", meta: {
      event_id: event.event_id, room_id: event.room_id, sender_id: event.sender,
    } })
  }
  if (role === "leader") context.roster = await rpc("task", { operation: "roster", role, team: frame.team })
  return { context, schema: await rpc("task", { operation: "schema", role }) }
}

// One native executor at a time, including the canonical Task tool. A lost
// mutating result remains unconfirmed in Core and blocks this native turn.
export class Guard {
  private tail: Promise<unknown> = Promise.resolve()
  private uncertain = false

  constructor(private rpc: Rpc, private identity: Record<string, any>, private context: Record<string, any>,
    private measure?: <T>(name: string, execute: () => Promise<T>) => Promise<T>) {}

  serial<T>(run: () => Promise<T>): Promise<T> {
    const previous = this.tail
    const ready = this.measure ? this.measure("opencode.tool.queue", () => previous.then(() => {})) : previous
    const result = ready.then(() => {
      if (this.uncertain) throw Error("Native operation requires authoritative verification")
      return run()
    })
    this.tail = result.catch(() => {})
    return result
  }

  async admit() {
    if (this.uncertain) throw Error("Native operation requires authoritative verification")
    return this.rpc("recovery", { action: this.identity.event_key ? "matrix.message.current" : "admit_tools", identity: this.identity })
  }

  execute<T>(name: string, id: string, input: any, run: () => Promise<T>, readOnly = false): Promise<T> {
    return this.serial(async () => {
      await this.admit()
      if (this.context.planning || this.context.review || this.context.completion) {
        throw Error("This coordination phase permits only the public Task tool")
      }
      if (this.context.execution && ["write", "edit", "patch"].includes(name)) {
        const valid = await this.rpc("recovery", { action: "write_path", path: input.path,
          patch: name === "patch" ? input.patch : undefined,
          output: this.context.context.outputDirectory, scratch: this.context.context.scratchDirectory })
        if (!valid) throw Error("Write target must be inside this Task's outputDirectory or scratchDirectory")
      }
      const prefix = this.identity.event_key ? "matrix.message." : ""
      const operation = await this.rpc("recovery", { action: prefix + "begin_tools", identity: this.identity,
        calls: [{ id, name, arguments: input, ...(readOnly ? { read_only: true } : {}) }] })
      let result: T
      try {
        result = await run()
      } catch (error) {
        if (readOnly) {
          await this.rpc("recovery", { action: prefix + "finish_tools", identity: this.identity,
            operation_id: operation, results: [{ id, status: "error", effect: "none", content: { status: "error", effect: "none" } }] })
        } else {
          this.uncertain = true
        }
        throw error
      }
      try {
        await this.rpc("recovery", { action: prefix + "finish_tools", identity: this.identity,
          operation_id: operation, results: [{ id, content: result }] })
      } catch (error) {
        this.uncertain = true
        throw error
      }
      return result
    })
  }
}
