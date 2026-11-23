import unittest
from unittest.mock import Mock, patch
import json
import os
from pathlib import Path
import tempfile

from agentteams_opencode.bridge import Bridge
from task_recovery import RecoveryConflict


class DeliveryTests(unittest.TestCase):
    def bridge(self):
        bridge = Bridge.__new__(Bridge)
        bridge.client, bridge.recovery, bridge.matrix = Mock(), Mock(), Mock()
        bridge.own = "@alice:test"
        return bridge

    def test_delivery_uses_the_authoritative_generation_after_same_process_reclaim(self):
        bridge = self.bridge()
        identity = {"task_id": "node-1", "team_id": "team-1", "generation": 1, "instance_id": "instance", "process_id": "process"}
        saved = {"execution": {**identity, "generation": 2, "checkpoint": {"delivery": "pending"}}}
        def publish(client, room, text, checkpoint, sender, bind):
            bind(checkpoint)
            return "$delivered"
        with patch("agentteams_opencode.bridge.publish_raw_saved", publish):
            bridge.deliver(identity, "!room:test", "Saved report", saved)
        used = bridge.recovery.checkpoint.call_args.kwargs["expected_identity"]
        self.assertEqual(used["generation"], 2)
        bridge.recovery.delivered.assert_called_once_with("node-1", "team-1", "$delivered")

    def test_already_delivered_result_is_not_sent_again(self):
        bridge = self.bridge()
        saved = {"execution": {"checkpoint": {"delivery": "delivered"}}}
        with patch("agentteams_opencode.bridge.publish_raw_saved") as send:
            self.assertEqual(bridge.deliver({"task_id": "node-1"}, "!room:test", "", saved), saved)
            send.assert_not_called()

    def test_startup_task_discovery_does_not_require_a_new_matrix_notification(self):
        bridge = self.bridge()
        bridge.attempted = set()
        task = {"task_id": "node-1", "main_task_id": "main-1", "task_plan_id": "plan-1", "notifyTxn": "assignment-1",
                "room_id": "!room:test", "status": "in_progress", "execution": {
                    "generation": 1, "instance_id": "instance", "process_id": "process", "state": "active", "runtime": "opencode"}}
        bridge.recovery.claim.return_value = {"task": task, "spec": "Continue existing work"}
        bridge.recovery.prepare_reply.return_value = ({"execution": task["execution"]}, "Saved report")
        bridge.run_native = Mock(return_value={"answer": "Saved report"})
        bridge.deliver = Mock()
        bridge.tasks({"tasks": [{"task": task, "team_id": "team-1"}]}, [])
        arguments = bridge.run_native.call_args.args
        self.assertIsNone(arguments[2])
        self.assertEqual(arguments[3]["task_id"], "node-1")
        self.assertEqual(arguments[3]["room_id"], "!room:test")
        bridge.deliver.assert_called_once()

    def test_live_native_tool_may_finish_its_current_unconfirmed_operation(self):
        bridge = self.bridge()
        bridge.record, bridge.native = {}, {"role": "worker"}
        bridge.stop = Mock()
        bridge.stop.wait.return_value = False
        identity = {"task_id": "node-1", "team_id": "team-1", "generation": 1,
                    "instance_id": "instance", "process_id": "process"}
        bridge.recovery.current.return_value = {"execution": {**identity, "state": "needs_verification"}}
        bridge.matrix._message_owned.return_value = bridge.recovery.current.return_value
        child = Mock(returncode=0)
        child.poll.side_effect = [None, 0, 0]
        def spawn(*args, **kwargs):
            kwargs['stdout'].write(json.dumps({"answer": "saved", "phaseComplete": True}))
            return child
        with tempfile.TemporaryDirectory() as folder:
            bridge.home = bridge.workspace = Path(folder)
            with patch.dict(os.environ, {"AGENTTEAMS_PLUGIN_DIR": folder, "OPENCODE_HARNESS_DIR": folder}), \
                 patch('agentteams_opencode.bridge.prepare_prompts', return_value=''), \
                 patch('agentteams_opencode.bridge.subprocess.Popen', side_effect=spawn), \
                 patch('agentteams_opencode.bridge.log'):
                for message in (False, True):
                    with self.subTest(message=message):
                        child.poll.side_effect = [None, 0, 0]
                        current = {**identity, **({'event_key': 'source-1'} if message else {})}
                        self.assertEqual(bridge.run_native('finish this tool', current)['answer'], 'saved')
        child.wait.assert_not_called()

    def test_retired_final_callback_does_not_republish_a_verified_task_phase(self):
        for complete in (False, True):
            with self.subTest(complete=complete):
                bridge = self.bridge()
                bridge.attempted = set()
                task = {'task_id': 'node-1', 'main_task_id': 'main-1', 'task_plan_id': 'plan-1',
                        'notifyTxn': 'assignment', 'room_id': '!room:test', 'status': 'in_progress',
                        'execution': {'generation': 1, 'instance_id': 'instance', 'process_id': 'process',
                                      'state': 'active', 'runtime': 'opencode'}}
                bridge.recovery.claim.return_value = {'task': task, 'spec': 'Execute'}
                bridge.run_native = Mock(return_value={'answer': '', 'phaseComplete': complete})
                bridge.recovery.prepare_reply.side_effect = RecoveryConflict('no longer recoverable')
                bridge.deliver = Mock()
                snapshot = {'tasks': [{'team_id': 'team-1', 'task': task}]}
                if complete:
                    bridge.tasks(snapshot, [])
                    bridge.recovery.interrupted.assert_not_called()
                else:
                    with self.assertRaises(RecoveryConflict):
                        bridge.tasks(snapshot, [])
                    bridge.recovery.interrupted.assert_called_once()
                bridge.deliver.assert_not_called()


if __name__ == "__main__":
    unittest.main()
