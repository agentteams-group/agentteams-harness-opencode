import unittest
from unittest.mock import Mock, patch

from agentteams_opencode.bridge import Bridge


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
        bridge.deliver.assert_called_once()


if __name__ == "__main__":
    unittest.main()
