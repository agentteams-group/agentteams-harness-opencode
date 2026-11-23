"""Consume the Worker contract without writing desired or native secrets back."""
import os
from pathlib import Path
import yaml


def load(path):
    from worker_runtime_config import project
    record = yaml.safe_load(Path(path).read_text())
    worker = os.environ["AGENTTEAMS_WORKER_NAME"]
    projection = project(record, "opencode", worker)
    role = record["member"]["role"]
    role = {"team_leader": "leader", "standalone": "worker"}.get(role, role)
    if role not in {"worker", "leader"}:
        raise ValueError("OpenCode supports Worker and Leader roles; Manager is not implemented")
    if record.get("desired", {}).get("mcpServers"):
        raise ValueError("Additional MCP projection is not supported by this candidate")
    os.environ["AGENTTEAMS_AGENT_ROLE"] = role
    if record.get("team", {}).get("name"):
        os.environ["AGENTTEAMS_TEAM_NAME"] = record["team"]["name"]
    provider = projection["models"]["providers"]["agentteams-gateway"]
    return record, projection["channels"]["matrix"], {
        "role": role, "team": record.get("team", {}).get("name"),
        "model": provider["models"][0]["id"], "baseURL": provider["baseUrl"], "apiKey": provider["apiKey"],
    }
