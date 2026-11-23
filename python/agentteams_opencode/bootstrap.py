"""Restore member-owned inputs; native sessions are optional, private caches."""
import os
import json
from pathlib import Path
import subprocess


def restore(home):
    remote = os.environ["AGENTTEAMS_STORAGE_PREFIX"].rstrip("/") + "/agents/" + os.environ["AGENTTEAMS_WORKER_NAME"]
    listing = subprocess.run(["mc", "ls", "--json", remote + "/"], check=True, capture_output=True, text=True)
    objects = [json.loads(line) for line in listing.stdout.splitlines()]
    if any(item.get("status") != "success" for item in objects):
        raise ValueError("Member asset listing failed")
    keys = {item["key"] for item in objects}
    runtime = home / "runtime/runtime.yaml"
    runtime.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(["mc", "cp", remote + "/runtime/runtime.yaml", str(runtime)], check=True, stdout=subprocess.DEVNULL)
    # Prompts, skills and user settings share the member root. Do not mirror
    # native caches over Controller-owned runtime.yaml or compatibility input.
    for name in ("AGENTS.md", "SOUL.md", "IDENTITY.md"):
        if name in keys:
            subprocess.run(["mc", "cp", remote + "/" + name, str(home / name)], check=True, stdout=subprocess.DEVNULL)
    if not (home / "AGENTS.md").is_file():
        raise ValueError("Projected role instructions are missing")
    if "skills/" in keys:
        subprocess.run(["mc", "mirror", remote + "/skills/", str(home / "skills") + "/", "--overwrite"],
                       check=True, stdout=subprocess.DEVNULL)


if __name__ == "__main__":
    restore(Path(os.environ["AGENTTEAMS_WORKER_HOME"]))
