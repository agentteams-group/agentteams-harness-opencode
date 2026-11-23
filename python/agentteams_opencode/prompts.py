"""Project public Core role assets and member-owned instructions at startup."""
import json
from pathlib import Path
import yaml


def prepare(record, home, plugin):
    role = {"team_leader": "leader", "standalone": "worker"}.get(record["member"]["role"], record["member"]["role"])
    if role not in {"worker", "leader"}:
        raise ValueError("Unsupported OpenCode role")
    manifest = yaml.safe_load((plugin / "plugin.yaml").read_text())
    skills = home / "skills"
    skills.mkdir(parents=True, exist_ok=True)
    for old in skills.iterdir():
        if old.is_symlink() and old.resolve().is_relative_to(plugin.resolve()):
            old.unlink()
    for section in manifest.get("skills", {}).values():
        for skill in section:
            if role not in skill.get("roles", []) or skill["id"] == "mcporter":
                continue
            source = (plugin / skill["path"]).resolve()
            if not source.is_relative_to(plugin.resolve()):
                raise ValueError("Builtin skill escapes the Core package")
            target = skills / skill["id"]
            if not target.exists():
                target.symlink_to(source, target_is_directory=True)
    parts = [(plugin / "prompts/agent" / (role + ".md")).read_text()]
    if record.get("team"):
        parts.append((plugin / "prompts/team/TEAMS.md").read_text())
    parts.append("Current AgentTeams identities:\n" + json.dumps({"member": record["member"], "team": record.get("team", {})}))
    parts.extend(str(value) for value in record.get("desired", {}).get("inlineConfig", {}).values() if value)
    parts.extend((home / name).read_text() for name in ("AGENTS.md", "SOUL.md", "IDENTITY.md") if (home / name).is_file())
    return "\n\n".join(parts)
