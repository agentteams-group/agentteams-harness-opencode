# OpenCode Harness acceptance ledger

Declared roles: Worker, Leader. Deployment: Controller-managed container.
Native dependencies: OpenCode 2.4.1, Bun 1.3.3, Python 3.11+.

| Gate | Current evidence |
| --- | --- |
| Worker native tool/schema and durable User input | Real SDK, deterministic local model fixture passed |
| Leader verified handoff and role-specific native tool | Real SDK, deterministic local model fixture passed |
| Native shell crosses first wait window | Real SDK foreground call moves to background; adapter waits for the original shell's terminal result before receipt and submit |
| Native admission, serialization, unknown-effect fence | Unit regression passed |
| Native provider failure propagation | Actual SDK HTTP 401 regression: failed idle outcome rejects instead of sending an empty success |
| File snapshot and digest validation without a native session | Python regression passed |
| Core runtime, backend image selection and member projection | Go and Python regression passed on the integration branch |
| Formal container entrypoint | Build/smoke evidence must be attached to the frozen candidate |
| Simple real-model 10/10 and complex real-model 10/10 | Pending |
| Mixed Leader/Worker combinations | Pending |
| Crash restart with no new Matrix wake-up | Implementation present; live acceptance pending |
| Bidirectional Harness switch and retained-cache return-switch | Pending; file continuity must be verified in both directions |
| Cancellation, duplicate delivery, failed upload, unknown submit response | Local fencing coverage only; deployed fault drills pending |
| OTLP model/tool Trace correlation and content capture disabled | Native model streaming and tool executor instrumentation implemented; local OTLP export regression passed. Live Collector/Langfuse and Dashboard readback pending |

Protocol success and performance must be reported separately, with the original
attempts retained. Record Core/Harness SHA, actual image digest, model and role
combination, source Matrix event, Task, native session/call and final attachment
hashes. Follow the [Core admission guide](https://github.com/agentscope-ai/AgentTeams/blob/main/docs/design/harness-integration-guide.md).
