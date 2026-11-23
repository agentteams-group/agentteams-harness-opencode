"""Private stdin bridge to version-pinned Core assets. stdout is JSON only."""
import json
import os
from pathlib import Path
import sys


def common(name):
    root = os.environ["AGENTTEAMS_PLUGIN_DIR"]
    if root not in sys.path:
        sys.path.insert(0, root)
    import importlib
    return importlib.import_module("mcp.common." + name)


def execute(method, payload):
    if method == "task":
        return common("task_native").invoke(payload)
    if method != "recovery":
        raise ValueError("Unknown native bridge")
    if payload.get("action") in {"persist_outputs", "restore_outputs"}:
        from task_recovery import Recovery
        from . import files
        operation = files.persist if payload["action"] == "persist_outputs" else files.restore
        return operation(payload, Recovery(device_delivery=True))
    if payload.get("action") == "write_path":
        # Patch has multiple destinations. It is not enabled until each one
        # can be validated against the same public path checker.
        return not payload.get("patch") and common("task_context").task_write_path_allowed(
            payload.get("path"), payload["output"], payload["scratch"])
    from task_recovery_rpc import execute as recovery_execute
    return recovery_execute({**payload, "runtime": "opencode", "device_delivery": True})


def main():
    try:
        request = json.load(sys.stdin)
        print(json.dumps({"value": execute(request["method"], request["payload"])}, default=str))
    except Exception as error:
        # No token, model prompt, command line or request body in diagnostics.
        print(json.dumps({"error": type(error).__name__}))
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
