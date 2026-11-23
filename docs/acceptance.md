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
| Formal container entrypoint | Real Controller-managed OpenCode Leader and two Workers passed native SDK, Matrix and Task discovery readiness; role assets loaded from runtime-only member records |
| Simple real-model 10/10 and complex real-model 10/10 | Pending |
| Mixed Leader/Worker combinations | Pending |
| Crash restart with no new Matrix wake-up | Implementation present; live acceptance pending |
| Bidirectional Harness switch and retained-cache return-switch | Pending; file continuity must be verified in both directions |
| Cancellation, duplicate delivery, failed upload, unknown submit response | Local fencing coverage only; deployed fault drills pending |
| OTLP model/tool Trace correlation and content capture disabled | Actual Collector/Langfuse readback and Dashboard waterfall passed. Trace `18cb057ca94be709d227db0a51a4ffa3`: three generations, two tools, 33003 tokens, zero errors; metadata includes Task, room and native session. Capture content disabled |

Real Qwen3.6 Plus native business tasks passed the public independent Docker
oracles: CSV 23/23 and settlement 90/90. Those direct native runs used a stub
admission recorder and are business/tool evidence, not full Task protocol passes.

The first full Team run failed when the parent mistook an in-flight receipt
fence for replaced ownership. A red/green regression fixed this without relaxing
the native unknown-effect fence. The second run reached Task completion and
verified 13 actual Matrix attachment hashes, but failed coherent final delivery:
the Leader selected intermediate versions with repeated filenames. Core's
shared native completion binding now requires explicit final artifact selection
in that case. Both failures remain in the local evidence ledger; neither counts
as an admission pass.

The third full Team run passed functional end-to-end acceptance. A QwenPaw
Manager dispatched the original Human request to an OpenCode Leader and two
OpenCode Workers, all using Qwen3.6 Plus. The Leader autonomously planned four
steps, reviewed every submission and explicitly selected four final artifact
IDs. No operator modified files, repaired Task state or supplied the plan.

- Main Task: `task-80655cd9719eeca796ee081cb882858f`.
- Source Matrix event: `$e_98zlG9cqCegfAmKIm9AtQVWJLMCQ2xOVEYNyiEvUY`.
- Harness executable source: `88a0f29bdb139335d6c4c4cc5542dc26ac37d622`.
- Core shared assets: `7a0d2aa7f01f35565bd0205c72562eb7c986182d`;
  Controller Go binary: `6b2517ae1f9e0bb3b3cb203c35c05405956d43a3`.
- Actual local Harness image identity:
  `sha256:36b53e62de3726d5da8acecbbad93cf2f370c798e5e73ac6da1c73248537223c`.
- The original Human room received app.py, test_app.py, README.md and
  test_results.txt. Authenticated Matrix downloads matched every accepted
  artifact's SHA-256, size and version; no conflicting filenames remained.
- Independent public Docker oracle: **23/23 passed**, including execution of
  the delivered unittest suite. Zero operator intervention; zero pending approvals.
- Delivery time: **880.125 seconds**. The 300-second performance target **failed**.
- Ten correlated OpenCode traces contain 52 generations and 45 tool spans.
  One native glob error was recorded and the Agent continued autonomously;
  no generation errors were present. Input/output content was absent.
- Final selection Trace: `baedf7b033d93eef26295c387c0d4873`.
- Frozen executable source [tests](https://github.com/agentteams-group/agentteams-harness-opencode/actions/runs/45252881030)
  and [native amd64/arm64 image builds, Python import and SDK startup](https://github.com/agentteams-group/agentteams-harness-opencode/actions/runs/45254606528)
  passed. Build validation does not publish a release image.

This is one successful request following two retained failures, not 10/10
repeatability. The local Task protocol, byte-level delivery, business behavior,
performance and formal admission verdicts remain separate.

Protocol success and performance must be reported separately, with the original
attempts retained. Record Core/Harness SHA, actual image digest, model and role
combination, source Matrix event, Task, native session/call and final attachment
hashes. Follow the [Core admission guide](https://github.com/agentscope-ai/AgentTeams/blob/main/docs/design/harness-integration-guide.md).
