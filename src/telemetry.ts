import { ROOT_CONTEXT, trace, SpanStatusCode, type Span } from "@opentelemetry/api"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http"
import { resourceFromAttributes } from "@opentelemetry/resources"
import { BasicTracerProvider, BatchSpanProcessor } from "@opentelemetry/sdk-trace-base"
import { randomUUID } from "node:crypto"

// Export only timings, identities and usage. Prompts, tool arguments, results
// and credentials never become span attributes, even with content capture on.
export function telemetry(attributes: Record<string, string>) {
  if (process.env.AGENTTEAMS_OTEL_ENABLED !== "true") return undefined
  attributes["agentteams.turn.id"] = randomUUID().replaceAll("-", "")
  const fields = () => {
    const result: Record<string, string | string[]> = { ...attributes,
      "langfuse.user.id": attributes["agentteams.worker.name"],
      "langfuse.trace.tags": ["agentteams", "opencode", "worker-turn", ...["task", "team", "room"].flatMap(label =>
        attributes[`agentteams.${label}.id`] ? [`${label}:${attributes[`agentteams.${label}.id`]}`] : [])] }
    for (const [key, value] of Object.entries(attributes)) {
      result["langfuse.trace.metadata." + key] = value
      result["langfuse.observation.metadata." + key] = value
    }
    if (attributes["session.id"]) result["langfuse.session.id"] = attributes["session.id"]
    return result
  }
  const provider = new BasicTracerProvider({
    resource: resourceFromAttributes({ "service.name": "agentteams-opencode", "agentteams.runtime": "opencode" }),
    spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter())],
  })
  const tracer = provider.getTracer("agentteams.opencode", "0.1.0")
  const root = tracer.startSpan("opencode.turn", { attributes: fields() }, ROOT_CONTEXT)
  const parent = trace.setSpan(ROOT_CONTEXT, root)
  const start = (name: string, attrs: Record<string, string>) => tracer.startSpan(name, { attributes: { ...fields(), ...attrs } }, parent)
  const error = (span: Span, failure: unknown) => {
    span.setStatus({ code: SpanStatusCode.ERROR, message: failure instanceof Error ? failure.name : "Error" })
  }
  const pending = new Map<Request, { span: Span; end: (failure?: unknown) => void }>()
  return {
    session(id: string) {
      attributes["session.id"] = id
      attributes["agentteams.runtime.session_id"] = id
      attributes["agentteams.session.id"] = id
      root.setAttributes(fields())
    },
    async tool<T>(name: string, id: string, execute: () => Promise<T>) {
      const span = start(name, { "langfuse.observation.type": "tool", "tool.name": name, "tool.call.id": id })
      try { return await execute() } catch (failure) { error(span, failure); throw failure } finally { span.end() }
    },
    request(request: Request, model: string, kind: string) {
      const span = start("chat " + model, { "langfuse.observation.type": "generation",
        "gen_ai.operation.name": "chat", "gen_ai.request.model": model, "agentteams.request.kind": kind })
      const end = (failure?: unknown) => {
        if (!pending.delete(request)) return
        if (failure) error(span, failure)
        span.end()
      }
      pending.set(request, { span, end })
    },
    response(request: Request, response: Response) {
      const current = pending.get(request)
      if (!current) return response
      const { span, end } = current
      span.setAttribute("http.response.status_code", response.status)
      if (!response.ok || !response.body) { end(response.ok ? undefined : Error("HTTPError")); return response }
      const sse = response.headers.get("content-type")?.includes("text/event-stream")
      const reader = response.body.getReader(), decoder = new TextDecoder()
      let buffer = ""
      let complete = false
      const inspect = (data: string) => {
        if (data === "[DONE]") { complete = true; return }
        try {
          const value = JSON.parse(data)
          if (Array.isArray(value.choices) && value.choices.some((choice: any) => choice.finish_reason)) complete = true
          if (value.error) end(Error("ProviderError"))
          for (const [key, count] of Object.entries({ input_tokens: value.usage?.prompt_tokens,
            output_tokens: value.usage?.completion_tokens })) {
            if (typeof count === "number") span.setAttribute("gen_ai.usage." + key, count)
          }
        } catch { /* The native provider remains responsible for wire validation. */ }
      }
      return new Response(new ReadableStream({
        async pull(controller) {
          try {
            const next = await reader.read()
            if (next.done) {
              if (!sse) inspect(buffer)
              end(sse && !complete ? Error("IncompleteResponse") : undefined)
              controller.close()
              return
            }
            buffer += decoder.decode(next.value, { stream: true })
            if (sse) {
              const lines = buffer.split("\n")
              buffer = lines.pop()!
              for (const line of lines) if (line.startsWith("data:")) inspect(line.slice(5).trim())
            }
            controller.enqueue(next.value)
          } catch (failure) { end(failure); controller.error(failure) }
        },
        async cancel(reason) { end(complete ? undefined : Error("Cancelled")); await reader.cancel(reason) },
      }), { status: response.status, statusText: response.statusText, headers: response.headers })
    },
    async close(failure?: unknown) {
      for (const { end } of pending.values()) end(failure || Error("IncompleteRequest"))
      if (failure) error(root, failure)
      root.end()
      await provider.shutdown()
    },
  }
}

export type Telemetry = ReturnType<typeof telemetry>
