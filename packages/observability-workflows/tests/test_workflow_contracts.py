import pathlib
import unittest

import yaml


ROOT = pathlib.Path(__file__).resolve().parents[1]


def load(relative_path):
    with (ROOT / relative_path).open(encoding="utf-8") as stream:
        return yaml.safe_load(stream)


class WorkflowContractTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.manifest = load("manifest.yaml")
        cls.workflows = {
            workflow["name"]: workflow
            for workflow in (
                load(pathlib.Path("workflows") / filename)
                for filename in cls.manifest["workflows"]
            )
        }

    def step(self, workflow_name, step_name):
        workflow = self.workflows[workflow_name]
        return next(
            step
            for job in workflow["jobs"]
            for step in job["steps"]
            if step["name"] == step_name
        )

    def test_manifest_names_every_workflow_and_support_file(self):
        self.assertEqual(4, len(self.workflows))
        for filename in self.manifest["workflows"]:
            self.assertTrue((ROOT / "workflows" / filename).is_file(), filename)
        for relative_path in self.manifest["additionalFiles"]:
            self.assertTrue((ROOT / relative_path).is_file(), relative_path)

    def test_enqueue_matches_notification_outbox_contract(self):
        enqueue = self.step("@mgreten/observability-deliver-transition", "enqueue")["task"]
        self.assertEqual("enqueueNotification", enqueue["methodName"])
        self.assertEqual(
            {"workItem", "event", "urgency", "era", "payload"},
            set(enqueue["inputs"]),
        )

    def test_exact_enqueue_scope_and_send_workflow_reach_dispatch(self):
        dispatch = self.step("@mgreten/observability-deliver-transition", "dispatch")["task"]["inputs"]
        self.assertEqual("${{ run.id }}", dispatch["sourceWorkflowRunId"])
        self.assertEqual("enqueue-and-dispatch", dispatch["enqueueJobName"])
        self.assertEqual("enqueue", dispatch["enqueueStepName"])
        self.assertEqual("${{ inputs.sendWorkflow }}", dispatch["sendWorkflow"])

    def test_disabled_or_empty_delivery_is_guarded(self):
        delivery = self.step("@mgreten/observability-transition-watchdog", "deliver-transitions")
        self.assertIn('inputs.outboxSink == ""', delivery["guard"])
        self.assertIn("== 0", delivery["guard"])

    def test_transition_identity_is_outbox_identity(self):
        assertion = self.step(
            "@mgreten/observability-deliver-transitions",
            "validate-transition-identities",
        )["task"]["expr"]
        for field in ("workItem", "event", "era"):
            self.assertIn(field, assertion)


if __name__ == "__main__":
    unittest.main()
