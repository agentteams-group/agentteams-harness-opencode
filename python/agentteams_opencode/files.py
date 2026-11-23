"""Store native file bytes before publishing their shared tool receipt."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile


def remote(key):
    return os.environ["AGENTTEAMS_STORAGE_PREFIX"].rstrip("/") + "/" + key


def transfer(source, target):
    subprocess.run(["mc", "cp", source, target], check=True, capture_output=True, timeout=60)


def root_key(identity):
    # These IDs came from the Controller's execution claim, never tool input.
    return f"teams/{identity['team_id']}/shared/tasks/{identity['task_id']}/checkpoints/"


def persist(payload, recovery):
    identity = payload["identity"]
    recovery.tools_current(identity, verification=True)
    manifest = []
    for area in ("output", "scratch"):
        root = Path(payload[area]).resolve()
        for path in sorted(root.rglob("*")):
            if path.is_symlink():
                raise ValueError("Native checkpoint cannot preserve a symbolic link")
            if not path.is_file():
                continue
            # Freeze bytes while hashing and uploading the exact same snapshot.
            data = path.read_bytes()
            digest = hashlib.sha256(data).hexdigest()
            key = root_key(identity) + "file-" + digest
            with tempfile.NamedTemporaryFile() as frozen:
                frozen.write(data)
                frozen.flush()
                transfer(frozen.name, remote(key))
            manifest.append({"area": area, "name": path.relative_to(root).as_posix(),
                             "key": key, "sha256": digest, "size": len(data)})
    recovery.tools_current(identity, verification=True)
    return manifest


def restore(payload, recovery):
    from task_operation import admit
    task = recovery.tools_current(payload["identity"])
    checkpoint = task["execution"].get("checkpoint") or {}
    admit(checkpoint)
    manifest = None
    with tempfile.TemporaryDirectory() as directory:
        for artifact in reversed(checkpoint.get("artifacts") or []):
            if not artifact.get("key", "").startswith(root_key(payload["identity"]) + "tools-"):
                continue
            receipt = Path(directory) / "receipt"
            transfer(remote(artifact["key"]), str(receipt))
            data = receipt.read_bytes()
            if hashlib.sha256(data).hexdigest() != artifact["sha256"] or len(data) != artifact["size"]:
                raise ValueError("Native checkpoint receipt digest mismatch")
            for result in reversed(json.loads(data).get("results") or []):
                content = result.get("content") or {}
                if isinstance(content, dict) and "agentteams_files" in content.get("metadata", {}):
                    manifest = content["metadata"]["agentteams_files"]
                    break
            if manifest is not None:
                break
        for item in manifest or []:
            if item["area"] not in {"output", "scratch"} or not item["key"].startswith(root_key(payload["identity"]) + "file-"):
                raise ValueError("Native file checkpoint has a different scope")
            root = Path(payload[item["area"]]).resolve()
            target = (root / item["name"]).resolve()
            if target == root or not target.is_relative_to(root):
                raise ValueError("Native file checkpoint path escapes the Task")
            frozen = Path(directory) / "file"
            transfer(remote(item["key"]), str(frozen))
            data = frozen.read_bytes()
            if hashlib.sha256(data).hexdigest() != item["sha256"] or len(data) != item["size"]:
                raise ValueError("Native file checkpoint digest mismatch")
            recovery.tools_current(payload["identity"])
            target.parent.mkdir(parents=True, exist_ok=True)
            frozen.replace(target)
    return True
