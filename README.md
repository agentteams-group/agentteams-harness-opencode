# agentteams-harness-opencode

OpenCode 2.4.1 native Harness for AgentTeams **Worker and Leader** roles.
This is an experimental implementation, pending full Harness admission.

You run one image for either role. Controller-projected `runtime.yaml` selects
the identity, role, model, Matrix transport and credentials. The adapter registers
the public `task/v1` schema as `agentteams_task` in OpenCode, uses native file and
shell executors, and records their execution through Core's recovery journal.
The Controller retains Task authority, candidate review and final delivery.

## Candidate dependencies

- OpenCode SDK and plugin: **2.4.1**, pinned in `bun.lock`.
- Bun: **1.3.3**, exercised by the native integration tests.
- Python: **3.11 or newer**.
- AgentTeams Core: **`7a0d2aa7f01f35565bd0205c72562eb7c986182d`**
  ([integration branch](https://github.com/agentscope-ai/AgentTeams/tree/codex/opencode-harness-20261124)).
- The matching Controller image supplies `agt` and role assets; Core's pinned
  DeepSeek submodule supplies the existing Matrix transport helpers unchanged.

## Build and select

```sh
git clone https://github.com/agentscope-ai/AgentTeams.git core
git -C core checkout 7a0d2aa7f01f35565bd0205c72562eb7c986182d
git -C core submodule update --init deepseek-harness
make -C core build-agentteams-controller LOCAL_CONTROLLER=agentteams/controller:opencode
docker build --build-context at=./core \
  --build-arg AGENTTEAMS_CONTROLLER_IMAGE=agentteams/controller:opencode \
  -t agentteams/agentteams-harness-opencode:dev .
```

Use this Core candidate and select `spec.runtime: opencode` with the image you
built in `spec.image`. For a Team Leader, use the same runtime and image on the
Leader's Worker resource. Alternatively set `AGENTTEAMS_OPENCODE_WORKER_IMAGE`
on the Controller. There is no default published release image.

Your normal Controller-issued environment supplies storage, Matrix, gateway and
role credentials. The launcher explicitly exports `AGENTTEAMS_PLUGIN_DIR`, uses
the shared runtime supervisor to initialize `AGENTTEAMS_PROCESS_ID`, and reports
ready only after SDK startup plus Matrix and Task discovery.

Shell execution requires the explicit `AGENTTEAMS_YOLO=1` launch policy. Without
it, shell is denied; Task file writes remain scoped to the prepared directories.
The headless process does not leave invisible permission prompts waiting for
an interactive OpenCode client. `AGENTTEAMS_TURN_TIMEOUT_S` defaults to 900.

## Execution and recovery

- Persist accepted Matrix input in Core before advancing sync. Verify the
  native User row before confirming native input admission.
- Discover assigned Tasks on every startup, including without new Matrix input.
- Use the role-specific public Task schema and verified coordination receipts.
- Serialize native side effects across admission, execution and result receipts.
- Keep backgrounded native shell calls open until their terminal result. Preserve
  the original call ID, and fence the operation if its effect is unknown.
- Check native write/edit targets before execution using Core's path validator.
- Persist output/scratch bytes before confirming mutating tool results; verify
  hashes when reconstructing the current candidate's file snapshot.
- Reconstruct a fresh OpenCode session from public state and authorized room
  history. Retain the local SDK database as a private cache, never Task authority.
- Deliver saved replies using Core's shared transaction and device validation.

## Tests

```sh
bun install --frozen-lockfile --registry https://registry.npmjs.org
bun run typecheck
bun run test
PYTHONPATH=python:./core/shared/lib:./core/deepseek-harness/scripts python3 -m unittest discover -s tests -p 'test_*.py'
```

The native tests run the real OpenCode SDK against a deterministic local model
endpoint. They verify native User persistence, model-visible tools, file writes,
shell completion across its first wait window, and Leader planning. Python tests
cover role projection and file snapshot recovery. They do not establish live
model quality, deployment or full admission.

## Admission status

See [the acceptance ledger](docs/acceptance.md). The required real-model simple
10/10 and complex 10/10 runs, cross-Harness switching and return-switch, process
and interruption drills remain open. Real Qwen3.6 Plus native business tasks
passed the public CSV (23 checks) and settlement (90 checks) oracles. Actual
model/tool spans, token usage and disabled content capture have been read back
from Collector/Langfuse and the Dashboard. These individual runs do not replace
the full admission matrix.

One full Human → Manager → OpenCode Leader/two Workers → original Human room
request passed final file/hash verification and all 23 independent CSV checks,
with no operator intervention. It took 880.125 seconds and failed the 300-second
performance target. Two earlier failed attempts are retained in the ledger.

Manager, Matrix E2EE, Code Mode, nested subagents and native patch are not enabled.
Additional MCP tool projection, interactive Matrix approvals and standalone chat
file delivery are not implemented. Task file delivery uses Core's public Task API.
Do not advertise the candidate as production-certified or add it to a release's
default image matrix until these declared admission gates pass.

## License

Apache-2.0. OpenCode and its packages retain their upstream MIT license.
