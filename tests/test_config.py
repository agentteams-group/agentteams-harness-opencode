from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import yaml
from agentteams_opencode.config import load


class ConfigTests(unittest.TestCase):
    def record(self, role="worker"):
        return {"apiVersion": "agentteams.io/v1beta1", "kind": "MemberRuntimeConfig",
                "member": {"runtime": "opencode", "runtimeName": "alice", "role": role,
                           "matrixUserId": "@alice:test"},
                "team": {"name": "team-1"}, "storage": {"memberPrefix": "agents/alice"},
                "matrix": {"transport": {"homeserver": "https://matrix.test"}},
                "desired": {"model": {"model": "fixture", "gatewayUrl": "https://gateway.test"}}}

    def test_worker_and_leader_use_projected_role_and_current_credentials(self):
        for role in ("worker", "team_leader"):
            with self.subTest(role=role), tempfile.TemporaryDirectory() as directory, patch.dict("os.environ", {
                "AGENTTEAMS_WORKER_NAME": "alice", "AGENTTEAMS_WORKER_MATRIX_TOKEN": "matrix-fixture",
                "AGENTTEAMS_WORKER_GATEWAY_KEY": "gateway-fixture"}):
                path = Path(directory) / "runtime.yaml"
                path.write_text(yaml.safe_dump(self.record(role)))
                _, matrix, native = load(path)
                self.assertEqual(matrix["userId"], "@alice:test")
                self.assertEqual(native["baseURL"], "https://gateway.test/v1")
                self.assertEqual(native["role"], "leader" if role == "team_leader" else "worker")

    def test_does_not_advertise_manager_support(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict("os.environ", {
            "AGENTTEAMS_WORKER_NAME": "alice", "AGENTTEAMS_WORKER_MATRIX_TOKEN": "matrix-fixture",
            "AGENTTEAMS_WORKER_GATEWAY_KEY": "gateway-fixture"}):
            path = Path(directory) / "runtime.yaml"
            path.write_text(yaml.safe_dump(self.record("manager")))
            with self.assertRaisesRegex(ValueError, "Manager is not implemented"):
                load(path)


if __name__ == "__main__":
    unittest.main()
