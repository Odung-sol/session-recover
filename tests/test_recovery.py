import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

import session_recover as recovery
import install

A = "01234567-1234-4321-8123-0123456789ab"
B = "01234567-1234-4321-8123-0123456789ac"
C = "01234567-1234-4321-8123-0123456789ad"


def event(kind, payload, timestamp="2026-01-02T03:04:05Z"):
    return json.dumps({"type": kind, "payload": payload, "timestamp": timestamp}) + "\n"


def message(role, text, phase=None):
    return event("response_item", {"type": "message", "role": role, "phase": phase,
                                 "content": [{"type": "output_text", "text": text}]})


class RecoveryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name).resolve()
        self.project = self.home / "project"
        self.project.mkdir()
        self.codex = self.home / ".codex"
        self.sessions = self.codex / "sessions/2026/01/02"
        self.sessions.mkdir(parents=True)

    def rollout(self, sid=A, cwd=None, source="cli", body=None):
        path = self.sessions / ("rollout-" + sid + ".jsonl")
        path.write_text(event("session_meta", {"id": sid, "cwd": str(cwd or self.project), "source": source})
                        + (body if body is not None else message("user", "Continue the chart fix")
                           + message("assistant", "Chart fix verified; not deployed.", "final_answer")))
        return path

    def run_cli(self, *args):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = recovery.main(["--home", str(self.home), "--project", str(self.project), *args])
        return code, out.getvalue(), err.getvalue()

    def test_fallback_excludes_other_projects_and_subagents(self):
        self.rollout()
        self.rollout(B, self.home / "project-other")
        self.rollout(C, source={"subagent": {"other": "guardian"}})
        rows = recovery.discover(self.codex, {self.project}, [])
        self.assertEqual([r["id"] for r in rows], [A])

    def test_readonly_index_cannot_redirect_to_other_project(self):
        a = self.rollout()
        b = self.rollout(B, self.home / "other")
        db = self.codex / "state_5.sqlite"
        with sqlite3.connect(db) as c:
            c.execute("CREATE TABLE threads(id,cwd,rollout_path,updated_at,title,source)")
            c.execute("INSERT INTO threads VALUES(?,?,?,?,?,?)", (B, str(self.project), str(b), 100, "wrong", "cli"))
        before = hashlib.sha256(db.read_bytes()).digest()
        rows = recovery.discover(self.codex, {self.project}, [])
        self.assertEqual([r["id"] for r in rows], [A])
        self.assertEqual(hashlib.sha256(db.read_bytes()).digest(), before)

    def test_orca_links_known_session_without_copying_terminal_text(self):
        self.rollout()
        orca = self.home / "Library/Application Support/Orca"
        pane = orca / "terminal-history/pane"
        pane.mkdir(parents=True)
        (pane / "meta.json").write_text(json.dumps({"cwd": str(self.project)}))
        (pane / "output.log").write_text("password=never-copy-this\ncodex resume " + A)
        linked = recovery.orca_links(orca, {self.project}, {A})
        self.assertEqual(linked[0]["session_ids"], [A])
        self.assertNotIn("never-copy-this", json.dumps(linked))

    def test_partial_tail_keeps_last_completed_response(self):
        p = self.rollout(body=message("user", "<environment_context>private config</environment_context>")
            + message("assistant", "private analysis", "analysis")
            + event("response_item", {"type": "function_call_output", "output": "raw secret"})
            + message("assistant", "Finished validation", "final_answer")
            + event("event_msg", {"type": "task_complete", "last_agent_message": "Finished validation"})
            + '{"type":')
        data = recovery.transcript(p)
        self.assertEqual(data["users"], [])
        self.assertEqual([a["text"] for a in data["answers"]], ["Finished validation"])
        self.assertTrue(data["warnings"])
        self.assertNotIn("raw secret", json.dumps(data))
        self.assertNotIn("private analysis", json.dumps(data))

    def test_truncated_tail_reports_scope_and_reads_complete_records(self):
        p = self.rollout(body=message("assistant", "a" * 4000, "final_answer")
                         + message("assistant", "Latest answer", "final_answer"))
        data = recovery.transcript(p, max_tail=1500)
        self.assertEqual(data["answers"][-1]["text"], "Latest answer")
        self.assertIn("Only the final", data["warnings"][0])

    def test_empty_new_session_does_not_hide_completed_work(self):
        self.rollout()
        new = self.rollout(B, body=message("user", "Hello"))
        os.utime(new, (2000000000, 2000000000))
        code, out, _ = self.run_cli("--json", "--no-save")
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out)["sessions"][0]["id"], A)

    def test_exact_session_selection_and_no_source_mutation(self):
        p = self.rollout()
        self.rollout(B)
        before = hashlib.sha256(p.read_bytes()).digest()
        code, out, _ = self.run_cli("--session", A, "--json")
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out)["sessions"][0]["id"], A)
        self.assertEqual(hashlib.sha256(p.read_bytes()).digest(), before)
        folder = recovery.storage_dir(self.home / ".local/share/session-recover", self.project)
        self.assertEqual((folder / "latest.md").stat().st_mode & 0o777, 0o600)
        self.assertEqual(folder.stat().st_mode & 0o777, 0o700)
        self.assertEqual(len(list(folder.glob("*.json"))), 1)

    def test_missing_source_preserves_existing_capsule(self):
        p = self.rollout()
        self.assertEqual(self.run_cli()[0], 0)
        folder = recovery.storage_dir(self.home / ".local/share/session-recover", self.project)
        original = (folder / "latest.md").read_bytes()
        p.unlink()
        self.assertEqual(self.run_cli()[0], 2)
        self.assertEqual((folder / "latest.md").read_bytes(), original)

    def test_atomic_replace_failure_preserves_previous_file(self):
        p = self.home / "store/latest.md"
        recovery.private_write(p, "previous")
        with patch.object(recovery.os, "replace", side_effect=OSError("disk failure")):
            with self.assertRaises(OSError):
                recovery.private_write(p, "new")
        self.assertEqual(p.read_text(), "previous")
        self.assertEqual(list(p.parent.glob(".recover-*")), [])

    def test_broken_git_pointer_still_connects_worktree_and_reports_problem(self):
        (self.project / ".git").mkdir()
        wt = self.home / ".codex/worktrees/1234/project"
        wt.mkdir(parents=True)
        (wt / ".git").write_text("gitdir: " + str(self.project / ".git/worktrees/project"))
        owner, aliases = recovery.project_paths(wt, self.home)
        self.assertEqual(owner, self.project)
        self.assertIn(wt, aliases)
        self.assertEqual(recovery.git_status(wt)["status"], "unavailable")
        self.assertFalse((self.project / ".git/worktrees").exists())

    def test_redacts_common_secrets_addresses_and_url_queries(self):
        text = ("api_key=supersecret\nBearer opaque-secret\n"
                "https://example.test/api?credential=secret\n"
                "ghp_abcdefghijklmnopqrstuvwxyz\n0x" + "a" * 40)
        safe = recovery.redact(text)
        for sensitive in ("supersecret", "opaque-secret", "credential=secret", "ghp_", "0xaaaa"):
            self.assertNotIn(sensitive, safe)
        self.assertEqual(recovery.redact(A), A)

    def test_home_scope_is_rejected(self):
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(recovery.main(["--home", str(self.home), "--project", str(self.home)]), 2)

    def test_noninteractive_resume_only_prints_command(self):
        self.rollout()
        with patch.object(recovery.sys.stdin, "isatty", return_value=False), patch.object(recovery.os, "execvp") as launch:
            code, out, _ = self.run_cli("resume", "--session", A)
        self.assertEqual(code, 0)
        self.assertIn("codex resume " + A, out)
        launch.assert_not_called()

    def test_installer_is_idempotent_preserves_instructions_and_shared_directory_modes(self):
        instructions = self.codex / "AGENTS.md"
        instructions.write_text("Existing project boundaries.\n")
        (self.home / ".local/bin").mkdir(parents=True, mode=0o755)
        os.chmod(self.home / ".local/bin", 0o755)
        os.chmod(self.codex, 0o755)
        install.install(self.home, True)
        first = instructions.read_text()
        install.install(self.home, True)
        self.assertEqual(instructions.read_text(), first)
        self.assertTrue(first.startswith("Existing project boundaries.\n"))
        self.assertEqual(first.count(install.START), 1)
        self.assertEqual((self.home / ".local/bin").stat().st_mode & 0o777, 0o755)
        self.assertEqual(self.codex.stat().st_mode & 0o777, 0o755)
        backup = list((self.home / ".local/share/session-recover/backups").glob("*.md"))
        self.assertEqual(len(backup), 1)
        self.assertEqual(backup[0].read_text(), "Existing project boundaries.\n")


if __name__ == "__main__":
    unittest.main()
