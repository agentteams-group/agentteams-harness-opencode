import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from agentteams_opencode import files


class Recovery:
    def __init__(self, checkpoint=None):
        self.checkpoint = checkpoint or {}

    def tools_current(self, identity, verification=False):
        return {"execution": {"checkpoint": self.checkpoint}}


class FileRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name)
        self.identity = {"team_id": "team-1", "task_id": "node-1"}
        self.payload = {"identity": self.identity, "output": str(self.home / "output"), "scratch": str(self.home / "scratch")}
        Path(self.payload["output"]).mkdir()
        Path(self.payload["scratch"]).mkdir()
        self.objects = {}

    def transfer(self, source, target):
        if source.startswith("store/"):
            Path(target).write_bytes(self.objects[source])
        else:
            self.objects[target] = Path(source).read_bytes()

    def test_restores_verified_bytes_without_an_opencode_session(self):
        path = Path(self.payload["output"]) / "result.csv"
        path.write_text("a,b\n1,2\n")
        with patch.dict("os.environ", {"AGENTTEAMS_STORAGE_PREFIX": "store"}), patch.object(files, "transfer", self.transfer):
            manifest = files.persist(self.payload, Recovery())
            receipt = json.dumps({"results": [{"content": {"metadata": {"agentteams_files": manifest}}}]}).encode()
            key = files.root_key(self.identity) + "tools-digest.txt"
            self.objects["store/" + key] = receipt
            checkpoint = {"artifacts": [{"key": key, "sha256": hashlib.sha256(receipt).hexdigest(), "size": len(receipt)}]}
            path.unlink()
            files.restore(self.payload, Recovery(checkpoint))
            self.assertEqual(path.read_text(), "a,b\n1,2\n")
            self.objects["store/" + manifest[0]["key"]] = b"corrupt"
            with self.assertRaisesRegex(ValueError, "digest mismatch"):
                files.restore(self.payload, Recovery(checkpoint))

    def test_rejects_unknown_operations_before_copying_any_file(self):
        with patch.object(files, "transfer") as transfer:
            with self.assertRaises(Exception):
                files.restore(self.payload, Recovery({"operation": {"state": "unknown"}}))
            transfer.assert_not_called()

    def test_rejects_symlinks_in_a_checkpoint(self):
        outside = self.home / "outside"
        outside.write_text("private")
        (Path(self.payload["output"]) / "link").symlink_to(outside)
        with self.assertRaisesRegex(ValueError, "symbolic link"):
            files.persist(self.payload, Recovery())

    def test_overlapping_scratch_snapshot_uploads_identical_content_once(self):
        scratch = Path(self.payload['output']) / '.scratch'
        scratch.mkdir()
        (scratch / 'input.csv').write_text('id,amount\na,1.00\n')
        self.payload['scratch'] = str(scratch)
        with patch.dict('os.environ', {'AGENTTEAMS_STORAGE_PREFIX': 'store'}), \
             patch.object(files, 'transfer', side_effect=self.transfer) as transfer:
            manifest = files.persist(self.payload, Recovery())
        self.assertEqual({item['area'] for item in manifest}, {'output', 'scratch'})
        self.assertEqual(manifest[0]['key'], manifest[1]['key'])
        self.assertEqual(transfer.call_count, 1)


if __name__ == "__main__":
    unittest.main()
