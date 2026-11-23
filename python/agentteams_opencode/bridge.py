"""Matrix/Task orchestration using Core's durable ledger and native OpenCode."""
import json
import os
from pathlib import Path
import signal
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from matrix_channel import MatrixClient
from matrix_bridge import managed_matrix_event, managed_rooms, runtime_matrix_context, runtime_agent_user_ids, materialize_attachment
from task_recovery import Recovery, RecoveryConflict, RecoveryUnavailable
from worker_matrix_state import WorkerMatrix, matrix_event_key
from worker_matrix_raw import RawWorkerSync, publish_raw_saved, raw_room_history
from worker_handoff import recovery_scanned
from runtime_observability import event as log

from .config import load
from .prompts import prepare as prepare_prompts


class Bridge:
    def __init__(self):
        self.home = Path(os.environ["AGENTTEAMS_WORKER_HOME"])
        self.path = self.home / "runtime/runtime.yaml"
        self.workspace = self.home / "workspace"
        self.workspace.mkdir(parents=True, exist_ok=True)
        self.stop = threading.Event()
        self.ready = False
        self.recovery = Recovery(device_delivery=True)
        self.matrix = WorkerMatrix("opencode", recovery=self.recovery)
        self.rooms, self.joined, self.agents, self.transport = {}, set(), set(), {}
        self.attempted = set()
        self.refresh()
        self.receiver = RawWorkerSync(self.matrix, self.client, self.own, self.classify, self.observe)

    def refresh(self):
        # Credential rotation and the desired model are resolved again for each
        # native process. Private native config never overwrites this record.
        remote = os.environ["AGENTTEAMS_STORAGE_PREFIX"].rstrip("/") + "/agents/" + os.environ["AGENTTEAMS_WORKER_NAME"]
        with tempfile.TemporaryDirectory(dir=self.home) as directory:
            pending = Path(directory) / "runtime.yaml"
            subprocess.run(["mc", "cp", remote + "/runtime/runtime.yaml", str(pending)], check=True, stdout=subprocess.DEVNULL)
            record, transport, native = load(pending)
            pending.replace(self.path)
        own, rooms = runtime_matrix_context(self.path, os.environ["AGENTTEAMS_WORKER_NAME"], os.environ["AGENTTEAMS_MATRIX_DOMAIN"])
        if hasattr(self, "own") and self.own != own:
            raise RecoveryConflict("Worker Matrix identity changed during this process")
        self.record, self.transport, self.native, self.own = record, transport, native, own
        self.rooms = rooms
        self.agents = runtime_agent_user_ids(self.path)
        self.client = MatrixClient(transport["homeserver"], transport["accessToken"])
        if hasattr(self, "receiver"):
            self.receiver.client = self.client

    def observe(self, payload):
        self.joined = managed_rooms(self.client, payload, self.rooms, self.own, self.transport)
        return self.joined

    def decode(self, row):
        room = row["room_id"]
        policy = self.record.get("desired", {}).get("channelPolicy", {})
        denied = policy.get("dmDenyExtra" if self.rooms.get(room) == "personal" else "groupDenyExtra", [])
        sender = row["input"]["sender"]
        domain = os.environ["AGENTTEAMS_MATRIX_DOMAIN"]
        if any(value == "*" or sender == (value if value.startswith("@") and ":" in value else f"@{value.lstrip('@')}:{domain}") for value in denied):
            return None
        return managed_matrix_event(row, self.rooms, self.own, self.agents, self.transport)

    def classify(self, room, raw):
        result = self.decode({"room_id": room, "event_id": raw["event_id"], "input": raw})
        return result[:2] if result else None

    def run_native(self, text, identity, source=None, notification=None, *, check=False):
        instructions = prepare_prompts(self.record, self.home, Path(os.environ["AGENTTEAMS_PLUGIN_DIR"]))
        request = {**self.native, "home": str(self.home), "directory": str(self.workspace), "identity": identity,
                   "text": text, "instructions": instructions, "sources": [],
                   "allowShell": os.getenv("AGENTTEAMS_YOLO", "").lower() in {"1", "true"}}
        if source:
            key = matrix_event_key(source["room_id"], source["event_id"])
            snapshot = self.matrix.native_input(key)
            request["sources"].append({"key": key, "snapshot": snapshot})
            request["event"] = {"room_id": source["room_id"], "event_id": source["event_id"],
                                "sender": source["input"]["sender"], "meta": {"teamharness_coordination": notification} if notification else {}}
        elif notification:
            request["event"] = {"event_id": "recovery", "meta": {"teamharness_coordination": notification}}
        command = [os.getenv("OPENCODE_BUN", "bun"), str(Path(os.environ["OPENCODE_HARNESS_DIR"]) / "src/driver.ts")]
        if check:
            command.append("--check")
        log("inference.begin", runtime="opencode", task_id=identity.get("task_id"), event_id=(source or {}).get("event_id"))
        # The child and its native shell children share a process group. A
        # forced stop fences and terminates all of them, including on shutdown.
        with tempfile.TemporaryFile(mode="w+") as output:
            child = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=output, stderr=None, text=True, start_new_session=True)
            child.stdin.write(json.dumps(request))
            child.stdin.close()
            deadline = time.monotonic() + int(os.getenv("AGENTTEAMS_TURN_TIMEOUT_S", "900"))
            try:
                while child.poll() is None:
                    if self.stop.wait(0.25) or time.monotonic() >= deadline:
                        raise InterruptedError("Native execution stopped")
                    if identity:
                        if identity.get("event_key"):
                            current = self.matrix._message_owned(identity)
                            if current["execution"]["state"] != "active":
                                raise RecoveryConflict("Native message execution stopped")
                        else:
                            task = self.recovery.current(identity["task_id"], identity["team_id"])
                            execution = (task or {}).get("execution", {})
                            if execution.get("state") not in {"active", "released"} or any(execution.get(k) != identity[k] for k in ("generation", "instance_id", "process_id")):
                                raise RecoveryConflict("Native Task execution was replaced")
                if child.returncode:
                    raise RuntimeError("OpenCode native process failed")
                output.seek(0)
                return json.load(output)
            finally:
                if child.poll() is None:
                    os.killpg(child.pid, signal.SIGTERM)
                    try:
                        child.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        os.killpg(child.pid, signal.SIGKILL)
                        child.wait()

    def deliver(self, identity, room, text, saved):
        task = bool(identity.get("task_id"))
        execution = saved["execution"] if "execution" in saved else saved["task"]["execution"]
        if execution.get("checkpoint", {}).get("delivery") == "delivered":
            return saved
        if task:
            if execution["process_id"] != identity["process_id"] or execution["instance_id"] != identity["instance_id"]:
                raise RecoveryConflict("Saved reply belongs to another native process")
            identity = {**identity, "generation": execution["generation"]}
        def bind(checkpoint):
            if task:
                return self.recovery.checkpoint(identity["task_id"], identity["team_id"], checkpoint, expected_identity=identity)
            return self.matrix.message_checkpoint(identity, checkpoint)
        sent = publish_raw_saved(self.client, room, text, execution["checkpoint"], self.own, bind)
        if task:
            return self.recovery.delivered(identity["task_id"], identity["team_id"], sent)
        return self.matrix.message_delivered(identity, sent)

    def tasks(self, snapshot, sources):
        for entry in snapshot["tasks"]:
            claimed = self.recovery.claim(snapshot, entry)
            task = claimed["task"]
            execution = task["execution"]
            identity = {"task_id": task["task_id"], "team_id": entry["team_id"], **{k: execution[k] for k in ("generation", "instance_id", "process_id")}}
            if execution["state"] != "active" or execution.get("runtime") != "opencode":
                continue
            if (execution.get("checkpoint") or {}).get("delivery") == "pending":
                self.deliver(identity, task["room_id"], claimed["saved_result"], claimed)
                continue
            key = (identity["team_id"], identity["task_id"], identity["generation"])
            if task["status"] == "submitted" or key in self.attempted:
                continue
            if not task.get("task_plan_id"):
                raise RecoveryConflict("OpenCode requires the public task/v1 protocol")
            source = next((row for row in sources if row.get("work", {}).get("task_id") == task["task_id"] and row["room_id"] == task["room_id"]), None)
            notification = {"kind": "task_assigned", "task_id": task["task_id"], "main_task_id": task["main_task_id"],
                            "project_id": task.get("project_id", ""), "delivery_id": task["notifyTxn"]}
            self.attempted.add(key)
            try:
                result = self.run_native(self.recovery.resume_text({**task, "team_id": entry["team_id"], "spec": claimed["spec"]}), identity, source, notification)
                saved, text = self.recovery.prepare_reply(task["task_id"], entry["team_id"], result["answer"])
                self.deliver(identity, task["room_id"], text, saved)
            except Exception:
                self.recovery.interrupted(task["task_id"], entry["team_id"])
                raise

    def message(self, source, decoded):
        key = matrix_event_key(source["room_id"], source["event_id"])
        claim = self.matrix.message_claim(key)
        identity = claim["identity"]
        if claim["recovery"] == "deliver":
            return self.deliver(identity, source["room_id"], claim["saved_result"], claim)
        if claim["recovery"] != "resume":
            return
        text = claim["resume_text"]
        notification = (decoded.get("_task_protocol_meta") or {}).get("teamharness_coordination")
        if not notification:
            history = raw_room_history(self.client, self.matrix, self.own, source["room_id"], source["event_id"],
                                       lambda room, raw: self.classify(room, raw) == ("message", None))
            text += "\nEarlier authorized Matrix context:\n" + json.dumps(history)
        if decoded.get("kind", "text") != "text":
            prompt, _ = materialize_attachment({**decoded, "room_id": source["room_id"], "event_id": source["event_id"]},
                                              self.client, self.workspace, 25 * 1024 * 1024)
            text += "\n" + prompt
        result = self.run_native(text, identity, source, notification)
        self.matrix.message_current(identity)
        if result["phaseComplete"]:
            self.matrix.message_cancel(identity)
            return
        saved = self.matrix.message_save_reply(identity, result["answer"])
        self.deliver(identity, source["room_id"], result["answer"], saved)

    def poll(self):
        self.refresh()
        tasks = self.recovery.discover()
        for entry in tasks["tasks"]:
            if entry["task"].get("room_id"):
                self.rooms.setdefault(entry["task"]["room_id"], "team")
        snapshot, failures = self.receiver.poll(1000)
        sources = [row for row in self.matrix.pending(snapshot) if row["room_id"] in self.joined
                   and not snapshot["state"]["rooms"].get(row["room_id"], {}).get("gaps")]
        if not failures and not any(room.get("gaps") for room in snapshot["state"]["rooms"].values()) and not self.ready:
            subprocess.run(["agt", "worker", "report-ready", "--name", os.getenv("AGENTTEAMS_WORKER_CR_NAME", os.environ["AGENTTEAMS_WORKER_NAME"])], check=True)
            recovery_scanned()
            self.ready = True
            log("runtime.ready", evidence="native_sdk_matrix_and_task_scan")
        self.tasks(tasks, sources)
        for source in sources:
            if source["intent"] != "message":
                continue
            decoded = self.decode(source)
            if decoded and decoded[0] == "message":
                self.message(source, decoded[2])

    def run(self):
        self.run_native("", {}, check=True)
        self.matrix.start()
        while not self.stop.is_set():
            try:
                self.poll()
            except (ValueError, OSError, RuntimeError, subprocess.SubprocessError) as error:
                log("runtime.pending", error_type=type(error).__name__)
                self.stop.wait(2)


def main():
    bridge = Bridge()
    class Health(BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(200 if bridge.ready else 503)
            self.end_headers()
            self.wfile.write(json.dumps({"ok": bridge.ready}).encode())
        def log_message(self, *_args):
            pass
    server = ThreadingHTTPServer(("0.0.0.0", int(os.getenv("AGENTTEAMS_CONSOLE_PORT", "8088"))), Health)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    for name in (signal.SIGTERM, signal.SIGINT):
        signal.signal(name, lambda *_args: bridge.stop.set())
    try:
        bridge.run()
    finally:
        bridge.ready = False
        server.shutdown()


if __name__ == "__main__":
    main()
