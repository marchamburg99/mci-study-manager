#!/usr/bin/env python3
"""Local lesson-to-NotebookLM bridge. Credentials never enter the study vault."""

import argparse
import ctypes
import ctypes.util
import datetime as dt
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile

VERSION = "0.8.6"
SERVICE = b"de.mci.studymanager.notebooklm"
ACCOUNT = b"default"
QUIZ_FILE = "Lernquiz.json"
RESULT_FILE = "Lernquiz-Ergebnisse.json"


class BridgeError(Exception):
    pass


def keychain(value=None):
    if sys.platform != "darwin":
        raise BridgeError("Auf diesem System NOTEBOOKLM_AUTH_JSON prozessgebunden aus einem Secret-Store bereitstellen.")
    security = ctypes.CDLL(ctypes.util.find_library("Security"))
    core = ctypes.CDLL(ctypes.util.find_library("CoreFoundation"))
    find = security.SecKeychainFindGenericPassword
    find.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_char_p, ctypes.c_uint32,
                     ctypes.c_char_p, ctypes.POINTER(ctypes.c_uint32), ctypes.POINTER(ctypes.c_void_p), ctypes.POINTER(ctypes.c_void_p)]
    find.restype = ctypes.c_int32
    length, data, item = ctypes.c_uint32(), ctypes.c_void_p(), ctypes.c_void_p()
    status = find(None, len(SERVICE), SERVICE, len(ACCOUNT), ACCOUNT, ctypes.byref(length), ctypes.byref(data), ctypes.byref(item))
    free = security.SecKeychainItemFreeContent
    free.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
    core.CFRelease.argtypes = [ctypes.c_void_p]
    try:
        if value is None:
            if status != 0:
                raise BridgeError("NotebookLM ist nicht verbunden. Zuerst den Bridge-Befehl login ausführen.")
            return ctypes.string_at(data, length.value).decode("utf-8")
        encoded = value.encode("utf-8")
        if status == 0:
            update = security.SecKeychainItemModifyAttributesAndData
            update.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_uint32, ctypes.c_char_p]
            update.restype = ctypes.c_int32
            status = update(item, None, len(encoded), encoded)
        elif status == -25300:
            add = security.SecKeychainAddGenericPassword
            add.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_char_p, ctypes.c_uint32,
                            ctypes.c_char_p, ctypes.c_uint32, ctypes.c_char_p, ctypes.c_void_p]
            add.restype = ctypes.c_int32
            status = add(None, len(SERVICE), SERVICE, len(ACCOUNT), ACCOUNT, len(encoded), encoded, None)
        if status != 0:
            raise BridgeError("Die NotebookLM-Anmeldung konnte nicht im Schlüsselbund gespeichert werden.")
    finally:
        if data.value:
            free(None, data)
        if item.value:
            core.CFRelease(item)


def read_json(path):
    if path.stat().st_size > 2_000_000:
        raise BridgeError("Eine Lerndatei überschreitet die zulässige Größe.")
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (ValueError, UnicodeError):
        raise BridgeError("Eine Lerndatei enthält ungültiges JSON.") from None


def safe_path(root, relative):
    parts = Path(relative).parts
    if not parts or Path(relative).is_absolute() or any(p in (".", "..") or p.startswith(".") for p in parts):
        raise BridgeError("Ungültiger relativer Vault-Pfad.")
    path = root
    for part in parts:
        path = path / part
        if path.is_symlink():
            raise BridgeError("Symlinks werden für Lerndateien nicht verwendet.")
    if not path.resolve().is_relative_to(root):
        raise BridgeError("Dateipfad außerhalb des Studienordners.")
    return path


def write_json(path, value, *, create=False):
    content = json.dumps(value, ensure_ascii=False, indent=2) + "\n"
    if path.is_symlink():
        raise BridgeError("Symlink als Ausgabe blockiert.")
    descriptor, name = tempfile.mkstemp(prefix=".learning-", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as target:
            target.write(content)
            target.flush()
            os.fsync(target.fileno())
        if create:
            os.link(name, path)
        else:
            os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def session_context(args):
    root = Path(args.vault).expanduser().resolve(strict=True)
    session = safe_path(root, args.session)
    parts = Path(args.session).parts
    if len(parts) != 3 or not session.is_dir():
        raise BridgeError("Eine bestehende Unterrichtseinheit im aktuellen Semester auswählen.")
    # This is the app-owned identity index: read only, never create or repair it.
    index_path = root / parts[0] / ".mci-manager" / "event-paths.json"
    if index_path.is_symlink() or index_path.parent.is_symlink():
        raise BridgeError("Unsicherer Terminpfad-Index.")
    index = read_json(index_path)
    if not isinstance(index, dict) or index.get("version") != 2 or not isinstance(index.get("paths"), dict) or not isinstance(index.get("subjects"), dict):
        raise BridgeError("Der Terminpfad-Index wird nicht unterstützt.")
    relative = "/".join(parts[1:])
    keys = [args.subject_key] + [args.subject_key + "-" + kind for kind in ("vo", "ue", "ilv", "sonst")]
    if index["paths"].get(args.uid) != relative or not any(index["subjects"].get(key) == parts[1] for key in keys):
        raise BridgeError("Fach, UID und Terminordner stimmen nicht mit dem Studien-Manager überein.")
    return root, session, index


def cli_path():
    executable = shutil.which("notebooklm")
    if executable is None:
        raise BridgeError('NotebookLM-Werkzeug fehlt. Einmalig: uv tool install "notebooklm-py[browser]==0.8.6"')
    check = subprocess.run([executable, "--version"], capture_output=True, text=True, timeout=30, check=False)
    if check.returncode or not re.search(r"\b0\.8\.6\b", check.stdout):
        raise BridgeError("Diese Bridge benötigt notebooklm-py 0.8.6. Die installierte Version bitte prüfen.")
    return executable


class NotebookCLI:
    def __init__(self, home):
        self.executable = cli_path()
        self.env = {**os.environ, "NOTEBOOKLM_HOME": str(home),
                    "NOTEBOOKLM_AUTH_JSON": os.environ.get("NOTEBOOKLM_AUTH_JSON") or keychain()}
        for name in ("NOTEBOOKLM_PROFILE", "NOTEBOOKLM_NOTEBOOK", "NOTEBOOKLM_BACKEND", "NOTEBOOKLM_DEBUG_RPC", "NOTEBOOKLM_LOG_LEVEL"):
            self.env.pop(name, None)

    def run(self, *args, structured=True):
        try:
            result = subprocess.run([self.executable, "--quiet", *args], env=self.env,
                                    capture_output=True, text=True, timeout=360, check=False)
        except subprocess.TimeoutExpired:
            raise BridgeError("NotebookLM antwortet noch nicht. Auftrag bleibt für die Fortsetzung erhalten.") from None
        if result.returncode:
            # Upstream output may contain request/session details. Never echo it.
            raise BridgeError("NotebookLM-Aufruf fehlgeschlagen. Anmeldung, Verbindung und Kontingent prüfen; den Auftrag nicht löschen.")
        if not structured:
            return None
        try:
            value = json.loads(result.stdout)
        except ValueError:
            raise BridgeError("NotebookLM lieferte ein unbekanntes Antwortformat.") from None
        if not isinstance(value, dict):
            raise BridgeError("NotebookLM lieferte ein unbekanntes Antwortformat.")
        return value


def identifier(value):
    if not isinstance(value, str) or not re.fullmatch(r"[a-zA-Z0-9_-]{1,200}", value):
        raise BridgeError("NotebookLM lieferte eine ungültige Kennung.")
    return value


def timestamp(value):
    if not isinstance(value, str) or not re.match(r"^\d{4}-\d{2}-\d{2}T", value):
        raise BridgeError("Ungültiger Zeitpunkt in einer Lerndatei.")
    parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise BridgeError("Ein Lernzeitpunkt benötigt eine Zeitzone.")
    return parsed


def validate_quiz(quiz, uid, subject_key):
    def text(value):
        return isinstance(value, str) and bool(value.strip()) and len(value) <= 20_000
    if not isinstance(quiz, dict) or quiz.get("version") != 1 or quiz.get("eventUid") != uid or quiz.get("subjectKey") != subject_key:
        raise BridgeError("Das Lernquiz gehört nicht zum ausgewählten Termin.")
    if not all(text(quiz.get(key)) for key in ("id", "title", "notebookId", "artifactId")):
        raise BridgeError("Das Lernquiz enthält ungültige Metadaten.")
    timestamp(quiz.get("createdAt"))
    if not isinstance(quiz.get("sourcePaths"), list) or not quiz["sourcePaths"] or not all(text(p) for p in quiz["sourcePaths"]):
        raise BridgeError("Dem Lernquiz fehlen die verwendeten Quellen.")
    questions = quiz.get("questions")
    if not isinstance(questions, list) or not 1 <= len(questions) <= 50:
        raise BridgeError("Das Lernquiz enthält keine gültigen Fragen.")
    ids = set()
    for question in questions:
        if not isinstance(question, dict) or not all(text(question.get(key)) for key in ("id", "prompt", "topic")):
            raise BridgeError("Ungültige Frage im Lernquiz.")
        options = question.get("options")
        if question["id"] in ids or not re.fullmatch(r"[a-zA-Z0-9_-]+", question["id"]) or not isinstance(options, list) or not 2 <= len(options) <= 10 or not all(text(o) for o in options) or len(set(options)) != len(options):
            raise BridgeError("Ungültige Antworten im Lernquiz.")
        if type(question.get("correctIndex")) is not int or not 0 <= question["correctIndex"] < len(options) or not isinstance(question.get("explanation"), str) or len(question["explanation"]) > 20_000:
            raise BridgeError("Ungültiger Lösungsschlüssel im Lernquiz.")
        ids.add(question["id"])
    return quiz


def normalize_quiz(value, args, notebook, artifact, materials):
    if not isinstance(value, dict) or not isinstance(value.get("questions"), list) or not 1 <= len(value["questions"]) <= 50:
        raise BridgeError("NotebookLM hat kein lesbares Quiz erzeugt.")
    questions = []
    for number, item in enumerate(value["questions"], 1):
        if not isinstance(item, dict):
            raise BridgeError("NotebookLM lieferte ein unbekanntes Fragenformat.")
        options = item.get("answerOptions")
        prompt = item.get("question")
        if not isinstance(prompt, str) or not prompt.strip() or len(prompt) > 20_000 or not isinstance(options, list) or not 2 <= len(options) <= 10:
            raise BridgeError("Dieses Quiz enthält nicht unterstützte Fragen. Nur Single-Choice-Fragen anfordern.")
        if any(not isinstance(o, dict) or not isinstance(o.get("text"), str) or not o["text"].strip()
               or len(o["text"]) > 20_000 or type(o.get("isCorrect")) is not bool for o in options):
            raise BridgeError("NotebookLM lieferte ungültige Antwortmöglichkeiten.")
        correct = [i for i, option in enumerate(options) if option["isCorrect"]]
        if len(correct) != 1 or len({option["text"] for option in options}) != len(options):
            raise BridgeError("Jede Quizfrage muss genau eine richtige und unterscheidbare Antworten haben.")
        explanation = options[correct[0]].get("rationale", "")
        if not isinstance(explanation, str) or len(explanation) > 20_000:
            raise BridgeError("NotebookLM lieferte eine ungültige Erklärung.")
        questions.append({"id": "q" + str(number), "prompt": prompt, "topic": prompt,
                          "options": [o["text"] for o in options], "correctIndex": correct[0], "explanation": explanation})
    title = value.get("title")
    return {"version": 1, "id": identifier(artifact), "eventUid": args.uid, "subjectKey": args.subject_key,
            "title": title if isinstance(title, str) and title.strip() and len(title) <= 20_000 else "Quiz zur Unterrichtseinheit",
            "createdAt": dt.datetime.now(dt.timezone.utc).isoformat(), "notebookId": identifier(notebook),
            "artifactId": artifact, "sourcePaths": materials, "questions": questions}


def publish(args, cli_factory=NotebookCLI):
    root, session, _ = session_context(args)
    output = safe_path(root, str(session.relative_to(root) / QUIZ_FILE))
    lock_path = safe_path(root, str(session.relative_to(root) / "Lernquiz-Auftrag.lock"))
    with lock_path.open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise BridgeError("Für diese Einheit läuft bereits ein Quiz-Auftrag.") from None
        if output.exists():
            existing = read_json(output)
            validate_quiz(existing, args.uid, args.subject_key)
            return {"status": "ready", "quizPath": str(output.relative_to(root)), "existing": True}
        materials = list(dict.fromkeys([args.summary, *args.material]))
        if not 1 <= len(materials) <= 20 or not safe_path(root, args.summary).is_relative_to(session):
            raise BridgeError("Zusammenfassung muss in der Einheit liegen; höchstens 20 Materialien übergeben.")
        files = [safe_path(root, item) for item in materials]
        if any(not p.is_file() or p.suffix.lower() not in (".md", ".pdf", ".txt", ".docx", ".pptx", ".epub") for p in files):
            raise BridgeError("Nur bestehende Notizen und unterstützte Unterrichtsdokumente übergeben.")
        if any(p.stat().st_size > 50_000_000 for p in files) or sum(p.stat().st_size for p in files) > 100_000_000:
            raise BridgeError("Material ist zu groß. Die für diese Einheit relevanten Unterlagen auswählen.")
        fingerprint = hashlib.sha256()
        for name, path in zip(materials, files):
            fingerprint.update(name.encode())
            fingerprint.update(path.read_bytes())
        signature = fingerprint.hexdigest()
        job_path = safe_path(root, str(session.relative_to(root) / "Lernquiz-Auftrag.json"))
        job = read_json(job_path) if job_path.exists() else {"version": 1, "signature": signature, "sources": [], "pending": None}
        if not isinstance(job, dict) or job.get("version") != 1 or job.get("signature") != signature or not isinstance(job.get("sources"), list):
            raise BridgeError("Material wurde während eines Quiz-Auftrags verändert. Bestehenden Auftrag zuerst klären.")
        if job.get("pending"):
            raise BridgeError("Ein NotebookLM-Schreibaufruf blieb unbestätigt. Vor erneutem Start den Auftrag im Notebook prüfen; nicht blind wiederholen.")
        write_json(job_path, job)
        with tempfile.TemporaryDirectory(prefix="mci-notebooklm-") as temporary:
            cli = cli_factory(Path(temporary))
            cli.run("auth", "check", "--test", "--json")
            language = cli.run("language", "get", "--json")
            if "language" not in language or (language["language"] is not None and not isinstance(language["language"], str)):
                raise BridgeError("Die NotebookLM-Ausgabesprache konnte nicht geprüft werden.")
            if language["language"] is None:
                # NotebookLM quizzes use the account default rather than a per-quiz language flag.
                cli.run("language", "set", "de", "--json")
            if not job.get("notebookId"):
                # Include the vault identity to keep separate students/vaults apart.
                name = "MCI " + Path(args.session).parts[0] + " " + args.subject_key + " " + hashlib.sha256(str(root).encode()).hexdigest()[:8]
                notebooks = cli.run("list", "--json").get("notebooks")
                if not isinstance(notebooks, list):
                    raise BridgeError("NotebookLM-Notizbuchliste ist nicht lesbar.")
                matches = [n for n in notebooks if isinstance(n, dict) and n.get("title") == name]
                if len(matches) > 1:
                    raise BridgeError("Mehrere passende Notebooks gefunden. Zuordnung zuerst klären.")
                if matches:
                    job["notebookId"] = identifier(matches[0].get("id"))
                else:
                    job["pending"] = "create_notebook"
                    write_json(job_path, job)
                    response = cli.run("create", name, "--json")
                    job["notebookId"] = identifier(response.get("notebook", {}).get("id"))
                    job["pending"] = None
                write_json(job_path, job)
            notebook = identifier(job["notebookId"])
            for i, path in enumerate(files):
                if i >= len(job["sources"]):
                    job["pending"] = "upload_" + str(i)
                    write_json(job_path, job)
                    response = cli.run("source", "add", str(path), "--type", "file", "-n", notebook, "--json")
                    job["sources"].append(identifier(response.get("source", {}).get("id")))
                    job["pending"] = None
                    write_json(job_path, job)
                cli.run("source", "wait", identifier(job["sources"][i]), "-n", notebook, "--timeout", "300", "--json")
            if not job.get("artifactId"):
                job["pending"] = "generate_quiz"
                write_json(job_path, job)
                prompt = ("Erstelle auf Deutsch ausschließlich Single-Choice-Fragen mit jeweils genau einer richtigen Antwort. "
                          "Prüfe Verständnis und Anwendung der heutigen Einheit; berücksichtige die im Lernrückblick genannten Lücken. "
                          "Nutze nur die ausgewählten Quellen. Formuliere neue Beispiele und begründe die richtige Antwort.")
                selected = [part for source in job["sources"] for part in ("-s", identifier(source))]
                generated = cli.run("generate", "quiz", prompt, "-n", notebook, *selected, "--quantity", "standard", "--difficulty", "medium", "--json")
                job["artifactId"] = identifier(generated.get("task_id"))
                job["pending"] = None
                write_json(job_path, job)
            artifact = identifier(job["artifactId"])
            cli.run("artifact", "wait", artifact, "-n", notebook, "--timeout", "300", "--interval", "2", "--json")
            downloaded = Path(temporary) / "quiz.json"
            cli.run("download", "quiz", str(downloaded), "-n", notebook, "-a", artifact, "--format", "json", structured=False)
            quiz = normalize_quiz(read_json(downloaded), args, notebook, artifact, materials)
            write_json(output, quiz, create=True)
        return {"status": "ready", "quizPath": str(output.relative_to(root)), "existing": False}


def review(args):
    root, session, index = session_context(args)
    cutoff = dt.datetime.fromisoformat(args.before.replace("Z", "+00:00"))
    if cutoff.tzinfo is None:
        raise BridgeError("Der Unterrichtsbeginn benötigt eine Zeitzone.")
    reviews, pending = [], []
    for uid, relative in index["paths"].items():
        if not isinstance(relative, str) or len(Path(relative).parts) != 2:
            raise BridgeError("Ungültiger Terminpfad im Index.")
        path = safe_path(root, str(Path(args.session).parts[0] / Path(relative)))
        if path == session:
            continue
        quiz_path = safe_path(root, str(path.relative_to(root) / QUIZ_FILE))
        if not quiz_path.exists():
            continue
        quiz = read_json(quiz_path)
        if not isinstance(quiz, dict) or quiz.get("subjectKey") != args.subject_key:
            continue
        validate_quiz(quiz, uid, args.subject_key)
        if timestamp(quiz["createdAt"]) > cutoff:
            continue
        record_path = safe_path(root, str(path.relative_to(root) / RESULT_FILE))
        if not record_path.exists():
            pending.append(str(quiz_path.relative_to(root)))
            continue
        record = read_json(record_path)
        if not isinstance(record, dict) or record.get("version") != 1 or record.get("quizId") != quiz.get("id") or record.get("eventUid") != uid or record.get("subjectKey") != args.subject_key or not isinstance(record.get("attempts"), list):
            raise BridgeError("Frühere Quiz-Ergebnisse passen nicht zur Einheit.")
        if any(not isinstance(attempt, dict) for attempt in record["attempts"]):
            raise BridgeError("Ein früherer Quizversuch ist beschädigt.")
        attempts = [a for a in record["attempts"] if timestamp(a.get("completedAt")) <= cutoff]
        if not attempts:
            pending.append(str(quiz_path.relative_to(root)))
            continue
        attempt = max(attempts, key=lambda a: timestamp(a["completedAt"]))
        answers = attempt.get("answers")
        questions = quiz["questions"]
        if not isinstance(answers, dict) or len(answers) != len(questions) or any(not isinstance(q, dict) or q.get("id") not in answers
                or type(answers[q["id"]]) is not int or not isinstance(q.get("options"), list)
                or not 0 <= answers[q["id"]] < len(q["options"]) or type(q.get("correctIndex")) is not int
                or not 0 <= q["correctIndex"] < len(q["options"]) for q in questions):
            raise BridgeError("Ein früherer Quizversuch enthält ungültige Antworten.")
        missed = [{"question": q["prompt"], "topic": q["topic"], "selectedAnswer": q["options"][answers[q["id"]]],
                   "correctAnswer": q["options"][q["correctIndex"]], "explanation": q["explanation"]}
                  for q in questions if answers[q["id"]] != q["correctIndex"]]
        reviews.append({"eventUid": uid, "quizPath": str(quiz_path.relative_to(root)), "completedAt": attempt["completedAt"],
                        "correct": len(questions) - len(missed), "total": len(questions), "missedQuestions": missed})
    return {"status": "reviewed", "subjectKey": args.subject_key, "before": args.before,
            "reviews": reviews, "pendingQuizzes": pending}


def login():
    executable = cli_path()
    with tempfile.TemporaryDirectory(prefix="mci-notebooklm-login-") as temporary:
        storage = Path(temporary) / "storage_state.json"
        env = {**os.environ, "NOTEBOOKLM_HOME": temporary}
        for name in ("NOTEBOOKLM_AUTH_JSON", "NOTEBOOKLM_PROFILE", "NOTEBOOKLM_BACKEND", "NOTEBOOKLM_DEBUG_RPC", "NOTEBOOKLM_LOG_LEVEL"):
            env.pop(name, None)
        result = subprocess.run([executable, "login", "--storage", str(storage), "--browser", "chrome", "--browser-timeout", "600"],
                                env=env, capture_output=True, text=True, timeout=660, check=False)
        if result.returncode or not storage.is_file():
            raise BridgeError("Google-Anmeldung wurde nicht abgeschlossen.")
        read_json(storage)
        keychain(storage.read_text(encoding="utf-8"))
    return {"status": "connected", "storage": "macOS Keychain"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("login")
    for name in ("publish", "review"):
        command = commands.add_parser(name)
        command.add_argument("--vault", required=True)
        command.add_argument("--session", required=True)
        command.add_argument("--uid", required=True)
        command.add_argument("--subject-key", required=True)
        if name == "publish":
            command.add_argument("--summary", required=True)
            command.add_argument("--material", action="append", default=[])
        else:
            command.add_argument("--before", required=True)
    args = parser.parse_args()
    try:
        result = login() if args.command == "login" else publish(args) if args.command == "publish" else review(args)
        print(json.dumps(result, ensure_ascii=False))
    except (BridgeError, OSError, ValueError, KeyError, TypeError, subprocess.TimeoutExpired):
        error = sys.exc_info()[1]
        print(str(error) if isinstance(error, BridgeError) else "Lernauftrag konnte nicht sicher verarbeitet werden. Dateien und Verbindung prüfen.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
