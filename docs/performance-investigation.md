# Real-task latency investigation

The successful CSV Team request delivered in 880.125 seconds on executable
source `88a0f29`. This is a functional pass and a performance failure. The
request used a QwenPaw Manager and an OpenCode Leader plus two OpenCode Workers.

## What the saved evidence establishes

- Ten native phases made 52 model requests: 1015977 input and 30850 output
  tokens. Each request carried roughly 19538 input tokens on average. These
  are cumulative wire counts, not a million-token single prompt.
- Model spans total 584.193 seconds across parallel members. Tool spans total
  525.52 seconds, but include both parallel overlap and serial queue waiting.
  Neither total is an exclusive wall-clock decomposition.
- Four integration reads entered between 19:56:55.260Z and 19:56:55.840Z and
  finished between 19:57:20.059Z and 19:57:32.489Z. Their individual durations
  sum to 128.953 seconds; the entire batch occupies 37.229 seconds. The old
  spans start before the Guard queue. Treating every duration as file I/O
  overstates execution cost. The first read's old 24.799-second span cannot
  retrospectively be split into native execution and recovery RPC latency.
- Sixteen `agentteams_task` spans have median 3.252 seconds and total 96.02
  seconds. They include queueing and bridge work, not just Controller HTTP.
  This evidence does not establish that the shared Task protocol is the cause
  of the long request.
- The native session records the failed glob as `tool.execution` with a
  30-second search timeout. The image omitted ripgrep. SDK 2.4.1 searches for
  it on PATH, then attempts a GitHub download when absent. A fresh-cache,
  network-disabled production-image test reproduced both glob and grep
  failures. Installing ripgrep makes the same native tools pass offline.

## Changes and regression coverage

- Package ripgrep and run real native glob/grep against a local deterministic
  model inside each amd64/arm64 candidate image with `--network none` and a
  fresh native cache. This exercises executors, not only SDK construction.
- Keep original tool/call spans, adding child spans for serial queue waiting,
  bridge RPC operation, native executor and native background-shell settling.
  Async context preserves the original parent under concurrent SDK calls.
  Arguments, prompts, file bytes and credentials remain excluded.
- Reduce the parent ownership monitor from four checks per second to one.
  Every native effect still immediately checks its authoritative ownership;
  local stop signals are checked every 250 ms. A replaced-generation regression
  verifies the child is terminated at the new monitor cadence.
- When scratch is inside output, retain both manifest paths while uploading
  each identical content-addressed blob once per snapshot. No recovery evidence
  is skipped or inferred from a private cache.
- Actual SDK parallel-read regression verifies four queued calls and native
  execution child spans. Its captured model requests contain the role instruction
  exactly once on each iteration; duplicate role instruction injection was not
  reproduced.

Focused Linux container replay used a deterministic model and stub admission,
not the deployed Task backend: a `sleep 0.3` native shell plus four reads finished
in 1.658 seconds; the shell executor took 404.4 ms and native reads 1.04–5.07 ms.
The offline search replay passed in 1.409 seconds. These isolate native tools;
they do not prove production recovery RPC latency or a new full-Team time.

The old request's remaining recovery/storage latency needs a new measured
deployed run with the child spans. The 300-second goal remains open. The
20-request admission matrix, cross-Harness and interruption drills also remain
open; these changes do not promote this opt-in implementation to admission or
default release status.
