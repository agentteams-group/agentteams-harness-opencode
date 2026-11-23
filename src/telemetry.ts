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
    language(model: any) {
      const invoke = async (method: "doStream" | "doGenerate", options: any) => {
        const span = start("chat " + model.modelId, { "langfuse.observation.type": "generation",
          "gen_ai.operation.name": "chat", "gen_ai.request.model": model.modelId })
        let ended = false
        const end = (failure?: unknown) => { if (ended) return; ended = true; if (failure) error(span, failure); span.end() }
        const usage = (value: any) => {
          for (const [key, count] of Object.entries({ input_tokens: value?.inputTokens?.total,
            output_tokens: value?.outputTokens?.total })) {
            if (typeof count === "number") span.setAttribute("gen_ai.usage." + key, count)
          }
        }
        try {
          const result = await model[method](options)
          if (method === "doGenerate") { usage(result.usage); end(); return result }
          const reader = result.stream.getReader()
          return { ...result, stream: new ReadableStream({
            async pull(controller) {
              try {
                const next = await reader.read()
                if (next.done) { end(); controller.close(); return }
                if (next.value.type === "finish") usage(next.value.usage)
                if (next.value.type === "error") end(next.value.error)
                controller.enqueue(next.value)
              } catch (failure) { end(failure); controller.error(failure) }
            },
            async cancel(reason) { end(Error("Cancelled")); await reader.cancel(reason) },
          }) }
        } catch (failure) { end(failure); throw failure }
      }
      return new Proxy(model, { get(target, key) {
        if (key === "doStream" || key === "doGenerate") return (options: any) => invoke(key, options)
        const value = Reflect.get(target, key)
        return typeof value === "function" ? value.bind(target) : value
      } })
    },
    async close(failure?: unknown) { if (failure) error(root, failure); root.end(); await provider.shutdown() },
  }
}

export type Telemetry = ReturnType<typeof telemetry>
