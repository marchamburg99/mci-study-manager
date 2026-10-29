import argparse
import copy
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

BRIDGE = Path(__file__).resolve().parents[1] / "src/scaffold/vault/skills/unterricht-vorbei/scripts/notebooklm_bridge.py"
spec = importlib.util.spec_from_file_location("notebooklm_bridge", BRIDGE)
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)

EXPORTED = {"title": "Keys", "questions": [{"question": "What identifies a row?", "answerOptions": [
    {"text": "Primary key", "isCorrect": True, "rationale": "A primary key uniquely identifies each row."},
    {"text": "Display order", "isCorrect": False, "rationale": "Order is not identity."},
]}]}


class FakeCLI:
    calls = []
    fail_wait_once = False

    def __init__(self, home):
        self.home = home

    def run(self, *args, structured=True):
        self.calls.append(args)
        if args[0] == "auth":
            return {"status": "ok"}
        if args[:2] == ("language", "get"):
            return {"language": None}
        if args[:2] == ("language", "set"):
            return {"language": args[2]}
        if args[0] == "list":
            return {"notebooks": []}
        if args[0] == "create":
            return {"notebook": {"id": "notebook-1"}}
        if args[:2] == ("source", "add"):
            return {"source": {"id": "source-" + str(len(self.calls))}}
        if args[:2] == ("source", "wait"):
            return {"status": "ready"}
        if args[:2] == ("generate", "quiz"):
            return {"task_id": "artifact-1", "status": "pending"}
        if args[:2] == ("artifact", "wait"):
            if self.fail_wait_once:
                FakeCLI.fail_wait_once = False
                raise bridge.BridgeError("Temporary wait failure")
            return {"status": "completed"}
        if args[:2] == ("download", "quiz"):
            Path(args[2]).write_text(json.dumps(EXPORTED))
            return None
        raise AssertionError(args)


class LessonCycleTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()
        self.session = self.root / "Sem01/01-databases/lesson-1"
        self.session.mkdir(parents=True)
        (self.session / "Zusammenfassung.md").write_text("# Keys\nA primary key identifies a row.\n")
        (self.session / "notes.md").write_text("Student's original notes\n")
        index_path = self.root / "Sem01/.mci-manager"
        index_path.mkdir()
        self.index = {"version": 2, "paths": {"lesson-1": "01-databases/lesson-1", "lesson-2": "02-databases/lesson-2"},
                      "subjects": {"databases-vo": "01-databases", "databases-ue": "02-databases"}, "reserved": [], "files": {}, "subjectFiles": {}}
        (index_path / "event-paths.json").write_text(json.dumps(self.index))
        (self.root / "Sem01/02-databases/lesson-2").mkdir(parents=True)
        self.args = argparse.Namespace(vault=str(self.root), session="Sem01/01-databases/lesson-1", uid="lesson-1",
                                       subject_key="databases", summary="Sem01/01-databases/lesson-1/Zusammenfassung.md",
                                       material=["Sem01/01-databases/lesson-1/notes.md"])
        FakeCLI.calls = []
        FakeCLI.fail_wait_once = False

    def tearDown(self):
        self.temp.cleanup()

    def publish(self):
        return bridge.publish(self.args, FakeCLI)

    def next_review(self):
        args = argparse.Namespace(vault=str(self.root), session="Sem01/02-databases/lesson-2", uid="lesson-2",
                                  subject_key="databases", before="2099-01-01T09:00:00+01:00")
        return bridge.review(args)

    def test_summary_upload_quiz_download_and_idempotent_replay(self):
        self.assertEqual(self.publish()["status"], "ready")
        quiz = json.loads((self.session / bridge.QUIZ_FILE).read_text())
        self.assertEqual((quiz["eventUid"], quiz["subjectKey"], quiz["questions"][0]["correctIndex"]), ("lesson-1", "databases", 0))
        self.assertEqual(len([c for c in FakeCLI.calls if c[:2] == ("source", "add")]), 2)
        generate = next(c for c in FakeCLI.calls if c[:2] == ("generate", "quiz"))
        self.assertEqual(generate.count("-s"), 2)
        self.assertNotIn("--language", generate)
        call_count = len(FakeCLI.calls)
        self.assertTrue(self.publish()["existing"])
        self.assertEqual(len(FakeCLI.calls), call_count)
        self.assertEqual((self.session / "notes.md").read_text(), "Student's original notes\n")
        self.assertIn(("language", "set", "de", "--json"), FakeCLI.calls)

    def test_preserves_an_explicit_notebooklm_account_language(self):
        original = FakeCLI.run
        def existing_language(instance, *args, **kwargs):
            if args[:2] == ("language", "get"):
                return {"language": "fr"}
            return original(instance, *args, **kwargs)
        with patch.object(FakeCLI, "run", existing_language):
            self.publish()
        self.assertFalse(any(call[:2] == ("language", "set") for call in FakeCLI.calls))

    def test_accepts_the_actual_app_written_index(self):
        script = """
import { assignEventPaths } from './src/lib/identity.ts';
const events = ['VO', 'UE'].map((typ, i) => ({
  uid: `real-lesson-${i}`, summary: 'Databases', fach: 'Databases', typ,
  dozent: 'Example', lvNummer: '', fachKey: 'databases', fachDir: '', terminRel: '',
  start: `2026-10-${28 + i}T09:00:00Z`, end: `2026-10-${28 + i}T11:00:00Z`,
}));
const plan = assignEventPaths(null, [], events);
console.log(JSON.stringify({index: JSON.parse(plan.raw), events: plan.events}));
"""
        output = subprocess.check_output(["node", "--input-type=module", "-e", script], cwd=BRIDGE.parents[6], text=True)
        generated = json.loads(output)
        (self.root / "Sem01/.mci-manager/event-paths.json").write_text(json.dumps(generated["index"]))
        first, second = generated["events"]
        for event in (first, second):
            (self.root / "Sem01" / event["terminRel"]).mkdir(parents=True, exist_ok=True)
        self.args.session = "Sem01/" + first["terminRel"]
        self.args.uid = first["uid"]
        self.args.summary = self.args.session + "/Zusammenfassung.md"
        self.args.material = []
        (self.root / self.args.summary).write_text("# Database keys\n")
        self.assertEqual(self.publish()["status"], "ready")
        next_args = argparse.Namespace(vault=str(self.root), session="Sem01/" + second["terminRel"],
                                       uid=second["uid"], subject_key="databases", before="2099-01-01T09:00:00Z")
        self.assertEqual(len(bridge.review(next_args)["pendingQuizzes"]), 1)

    def test_next_lesson_evaluates_real_answers_across_course_types(self):
        self.publish()
        record = {"version": 1, "quizId": "artifact-1", "eventUid": "lesson-1", "subjectKey": "databases",
                  "attempts": [{"completedAt": "2026-10-29T16:00:00Z", "answers": {"q1": 1}}]}
        (self.session / bridge.RESULT_FILE).write_text(json.dumps(record))
        result = self.next_review()
        self.assertEqual((result["reviews"][0]["correct"], result["reviews"][0]["total"]), (0, 1))
        self.assertEqual(result["reviews"][0]["missedQuestions"][0]["selectedAnswer"], "Display order")
        record["attempts"].append({"completedAt": "2026-10-30T08:00:00Z", "answers": {"q1": 0}})
        (self.session / bridge.RESULT_FILE).write_text(json.dumps(record))
        self.assertEqual(self.next_review()["reviews"][0]["missedQuestions"], [])

    def test_pending_quiz_is_untested_not_failed(self):
        self.publish()
        result = self.next_review()
        self.assertEqual(result["reviews"], [])
        self.assertEqual(len(result["pendingQuizzes"]), 1)

    def test_artifact_wait_resumes_without_upload_or_generation_duplicates(self):
        FakeCLI.fail_wait_once = True
        with self.assertRaises(bridge.BridgeError):
            self.publish()
        self.assertFalse((self.session / bridge.QUIZ_FILE).exists())
        self.publish()
        self.assertEqual(len([c for c in FakeCLI.calls if c[0] == "create"]), 1)
        self.assertEqual(len([c for c in FakeCLI.calls if c[:2] == ("generate", "quiz")]), 1)

    def test_unknown_mutation_outcome_stops_instead_of_repeating(self):
        original = FakeCLI.run
        def fail_create(instance, *args, **kwargs):
            if args[0] == "create":
                raise bridge.BridgeError("Lost response")
            return original(instance, *args, **kwargs)
        with patch.object(FakeCLI, "run", fail_create):
            with self.assertRaises(bridge.BridgeError):
                self.publish()
        with self.assertRaisesRegex(bridge.BridgeError, "unbestätigt"):
            self.publish()

    def test_malformed_and_multiple_answer_keys_are_rejected(self):
        for value in ({"questions": []}, {"questions": None}, {"questions": [{"question": "Why?", "answerOptions": []}]}):
            with self.assertRaises(bridge.BridgeError):
                bridge.normalize_quiz(value, self.args, "notebook-1", "artifact-1", ["source.md"])
        value = copy.deepcopy(EXPORTED)
        value["questions"][0]["answerOptions"][1]["isCorrect"] = True
        with self.assertRaises(bridge.BridgeError):
            bridge.normalize_quiz(value, self.args, "notebook-1", "artifact-1", ["source.md"])

    def test_paths_and_identity_cannot_escape_the_selected_lesson(self):
        self.args.subject_key = "coding"
        with self.assertRaises(bridge.BridgeError):
            self.publish()
        for name in ("../outside.md", "/etc/passwd", "Sem01/.mci-manager/event-paths.json"):
            with self.assertRaises(bridge.BridgeError):
                bridge.safe_path(self.root, name)
        (self.session / "link.md").symlink_to(self.session / "notes.md")
        with self.assertRaises(bridge.BridgeError):
            bridge.safe_path(self.root, "Sem01/01-databases/lesson-1/link.md")

    def test_corrupt_attempts_are_not_treated_as_learning_evidence(self):
        self.publish()
        (self.session / bridge.RESULT_FILE).write_text('{"version":1,"quizId":"other","attempts":[]}')
        with self.assertRaises(bridge.BridgeError):
            self.next_review()

    def test_failed_upstream_output_cannot_disclose_credentials(self):
        completed = argparse.Namespace(returncode=1, stdout="secret-cookie-value", stderr="secret-cookie-value")
        with patch.object(bridge, "cli_path", return_value="/trusted/notebooklm"), patch.object(bridge, "keychain", return_value='{"cookies":[]}'):
            cli = bridge.NotebookCLI(self.root)
        with patch.object(bridge.subprocess, "run", return_value=completed):
            with self.assertRaises(bridge.BridgeError) as caught:
                cli.run("list", "--json")
        self.assertNotIn("secret-cookie-value", str(caught.exception))

    def test_login_saves_the_requested_file_and_keeps_upstream_output_private(self):
        saved_paths = []
        def complete_login(command, **kwargs):
            self.assertLess(command.index("login"), command.index("--storage"))
            self.assertTrue(kwargs.get("capture_output"))
            self.assertNotIn("NOTEBOOKLM_AUTH_JSON", kwargs["env"])
            target = Path(command[command.index("--storage") + 1])
            target.write_text('{"cookies":[],"origins":[]}')
            saved_paths.append(target)
            return argparse.Namespace(returncode=0, stdout="private-account@example.test", stderr="")
        with patch.object(bridge, "cli_path", return_value="/trusted/notebooklm"), patch.object(bridge.subprocess, "run", side_effect=complete_login), patch.object(bridge, "keychain") as store:
            self.assertEqual(bridge.login()["status"], "connected")
            self.assertEqual(json.loads(store.call_args.args[0]), {"cookies": [], "origins": []})
        self.assertTrue(saved_paths)
        self.assertFalse(saved_paths[0].exists())


if __name__ == "__main__":
    unittest.main()
