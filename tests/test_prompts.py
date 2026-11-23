import os
from pathlib import Path
import tempfile
import unittest
from agentteams_opencode.prompts import prepare


class PromptTests(unittest.TestCase):
    def test_fresh_runtime_only_member_gets_public_role_assets_and_inline_instructions(self):
        plugin = Path(__file__).resolve().parents[1] / 'core/plugins/teamharness'
        if not plugin.is_dir():
            plugin = Path(os.environ['AGENTTEAMS_TEST_CORE']) / 'plugins/teamharness'
        with tempfile.TemporaryDirectory() as temp:
            home = Path(temp)
            record = {'member': {'role': 'worker', 'name': 'one'}, 'team': {'name': 'team-proof'},
                      'desired': {'inlineConfig': {'agents': 'You verify business outputs.'}}}
            text = prepare(record, home, plugin)
            self.assertIn('You are a Worker', text)
            self.assertIn('team-proof', text)
            self.assertIn('You verify business outputs.', text)
            self.assertTrue((home / 'skills/task-execution/SKILL.md').is_file())
            record['member']['role'] = 'team_leader'
            text = prepare(record, home, plugin)
            self.assertIn('Leader', text)
            self.assertTrue((home / 'skills/task-management/SKILL.md').is_file())
            self.assertFalse((home / 'skills/task-execution').exists())
