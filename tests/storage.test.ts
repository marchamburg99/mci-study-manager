import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  apiChooseVaultRoot,
  apiOpenVaultFile,
  apiPickDocuments,
  apiReadText,
  apiSaveText,
  calendarCachePath,
  ensureTermin,
  ensureVault,
  isConflictError,
  loadConfig,
  notesPath,
  readTerminNote,
  saveTerminNote,
  setTerminStatus,
} from "../src/lib/storage";
import { parseNote, serializeNote } from "../src/lib/notes";
import type { AppConfig, StudyEvent } from "../src/lib/types";

const cfg: AppConfig = { basisPfad: "/mock-vault", semester: "Sem01", icalUrl: "https://example.test/private-feed", refreshHours: 12, lastRefresh: null };
const event: StudyEvent = {
  uid: "one", fach: "Coding", typ: "UE", summary: "Coding", dozent: "Example", lvNummer: "1",
  start: "2026-09-22T08:00:00.000Z", end: "2026-09-22T09:00:00.000Z",
  fachKey: "coding-ue", fachDir: "01-coding-ue_example", terminRel: "01-coding-ue_example/2026-09-22_coding-ue",
};
const notePath = `/mock-vault/Sem01/${event.terminRel}/notes.md`;
const metaPath = `/mock-vault/Sem01/${event.terminRel}/meta.json`;
const body = "## Vorbereitung\n- [x] Read\n\n## Nachbereitung\n- [ ] Review\n";
let files: Map<string, string>;
let errors: Map<string, unknown>;
let calls: Array<{ command: string; args: Record<string, unknown> }>;
let beforeSave: ((path: string) => void) | undefined;
let beforeRead: ((path: string) => void) | undefined;
let chosenRoot: string | null;

beforeEach(() => {
  files = new Map();
  errors = new Map();
  calls = [];
  beforeSave = undefined;
  beforeRead = undefined;
  chosenRoot = null;
  vi.stubGlobal("window", {});
  mockIPC((command, payload) => {
    const args = (payload ?? {}) as Record<string, unknown>;
    calls.push({ command, args });
    const path = args.path as string;
    if (errors.has(`${command}:${path}`)) throw errors.get(`${command}:${path}`);
    switch (command) {
      case "plugin:path|join": return (args.paths as string[]).join("/");
      case "plugin:path|resolve_directory": return "/mock-home";
      case "read_text_file":
        beforeRead?.(path);
        return files.get(path) ?? null;
      case "save_text_file":
        beforeSave?.(path);
        if ((files.get(path) ?? null) !== args.expected) throw "CONFLICT";
        files.set(path, args.content as string);
        return;
      case "delete_file": files.delete(path); return;
      case "ensure_dir": return;
      case "choose_vault_root": return chosenRoot;
      case "open_vault_file": return;
      case "pick_documents": return ["/mock-picked/script.pdf"];
      default: throw new Error(`Unexpected IPC command: ${command}`);
    }
  });
});

afterEach(() => {
  clearMocks();
  vi.unstubAllGlobals();
});

describe("checked storage IPC", () => {
  it("only returns null for a native missing file", async () => {
    expect(await apiReadText(notePath)).toBeNull();
    files.set(notePath, "");
    expect(await apiReadText(notePath)).toBe("");
  });

  it("propagates read errors without creating files", async () => {
    errors.set(`read_text_file:${notePath}`, "Keine Leseberechtigung");

    await expect(ensureTermin(cfg, event)).rejects.toBe("Keine Leseberechtigung");
    expect(calls.some(({ command }) => command === "save_text_file" || command === "ensure_dir")).toBe(false);
  });

  it("passes null and exact raw expectations to native checked writes", async () => {
    await apiSaveText(notePath, "first", null);
    await apiSaveText(notePath, "second", "first");

    expect(calls.filter(({ command }) => command === "save_text_file")).toEqual([
      { command: "save_text_file", args: { path: notePath, content: "first", expected: null } },
      { command: "save_text_file", args: { path: notePath, content: "second", expected: "first" } },
    ]);
  });

  it("propagates conflicts and keeps the other writer's content", async () => {
    files.set(notePath, "external");

    await expect(apiSaveText(notePath, "mine", "stale")).rejects.toBe("CONFLICT");
    expect(files.get(notePath)).toBe("external");
    expect(isConflictError("CONFLICT")).toBe(true);
    expect(isConflictError(new Error("CONFLICT"))).toBe(true);
    expect(isConflictError(new Error("Other failure"))).toBe(false);
    expect(isConflictError(null)).toBe(false);
  });

  it("routes selection and opening through the authorized native commands", async () => {
    expect(await apiChooseVaultRoot()).toBeNull();
    chosenRoot = "/mock-picked/vault";
    expect(await apiChooseVaultRoot()).toBe(chosenRoot);
    expect(await apiPickDocuments()).toEqual(["/mock-picked/script.pdf"]);
    await apiOpenVaultFile(notePath);

    expect(calls.map(({ command }) => command)).toEqual(["choose_vault_root", "choose_vault_root", "pick_documents", "open_vault_file"]);
    expect(calls.at(-1)?.args).toEqual({ path: notePath });
  });

  it("rejects invalid note paths before filesystem access", async () => {
    await expect(notesPath(cfg, "../private")).rejects.toThrow("Pfad");
    expect(calls).toHaveLength(0);
  });
});

describe("termin note writes", () => {
  it("initializes an indexed empty note with event metadata and the exact empty revision", async () => {
    const file = "2026-09-22 1000 Coding.md";
    const namedPath = `/mock-vault/Sem01/${event.terminRel}/${file}`;
    files.set("/mock-vault/Sem01/.mci-manager/event-paths.json", JSON.stringify({ version: 2,
      paths: { one: event.terminRel }, subjects: {}, reserved: [], files: { [event.terminRel]: file }, subjectFiles: {} }));
    files.set(namedPath, "");

    const result = await ensureTermin(cfg, event);

    expect(result.data).toMatchObject({ uid: event.uid, fach: event.fach, typ: event.typ, lv: event.lvNummer });
    expect(result.raw).toBe(files.get(namedPath));
    expect(calls.find(({ command }) => command === "save_text_file")?.args).toMatchObject({ path: namedPath, expected: "" });
    expect(files.has(notePath)).toBe(false);
  });

  it("preserves external edits that race with empty indexed note initialization", async () => {
    files.set("/mock-vault/Sem01/.mci-manager/event-paths.json", JSON.stringify({ version: 2,
      paths: { one: event.terminRel }, subjects: {}, reserved: [], files: { [event.terminRel]: "notes.md" }, subjectFiles: {} }));
    files.set(notePath, "");
    beforeSave = (path) => files.set(path, "Concurrent personal note");

    await expect(ensureTermin(cfg, event)).rejects.toBe("CONFLICT");
    expect(files.get(notePath)).toBe("Concurrent personal note");
    expect(calls.find(({ command }) => command === "save_text_file")?.args.expected).toBe("");
  });

  it("does not initialize a placeholder after its indexed filename changes", async () => {
    const indexPath = "/mock-vault/Sem01/.mci-manager/event-paths.json";
    const index = { version: 2, paths: { one: event.terminRel }, subjects: {}, reserved: [],
      files: { [event.terminRel]: "notes.md" }, subjectFiles: {} };
    const otherPath = `/mock-vault/Sem01/${event.terminRel}/Other.md`;
    files.set(indexPath, JSON.stringify(index));
    files.set(notePath, "");
    files.set(otherPath, "");
    beforeRead = (path) => {
      if (path === notePath) files.set(indexPath, JSON.stringify({ ...index, files: { [event.terminRel]: "Other.md" } }));
    };

    await expect(ensureTermin(cfg, event)).rejects.toBe("CONFLICT");
    expect(files.get(notePath)).toBe("");
    expect(files.get(otherPath)).toBe("");
    expect(calls.some(({ command }) => command === "save_text_file")).toBe(false);
  });

  it("does not redirect a placeholder write if the index changes during its checked write", async () => {
    const indexPath = "/mock-vault/Sem01/.mci-manager/event-paths.json";
    const index = { version: 2, paths: { one: event.terminRel }, subjects: {}, reserved: [],
      files: { [event.terminRel]: "notes.md" }, subjectFiles: {} };
    const otherPath = `/mock-vault/Sem01/${event.terminRel}/Other.md`;
    files.set(indexPath, JSON.stringify(index));
    files.set(notePath, "");
    files.set(otherPath, "");
    beforeSave = () => files.set(indexPath, JSON.stringify({ ...index, files: { [event.terminRel]: "Other.md" } }));

    const result = await ensureTermin(cfg, event);

    expect(files.get(notePath)).toBe(result.raw);
    expect(files.get(otherPath)).toBe("");
  });

  it.each([
    null,
    { version: 1, paths: { one: event.terminRel }, subjects: {}, reserved: [] },
    { version: 2, paths: {}, subjects: {}, reserved: [], files: { [event.terminRel]: "notes.md" }, subjectFiles: {} },
    { version: 2, paths: { other: event.terminRel }, subjects: {}, reserved: [], files: { [event.terminRel]: "notes.md" }, subjectFiles: {} },
    { version: 2, paths: { one: event.terminRel, other: event.terminRel.toUpperCase() }, subjects: {}, reserved: [], files: { [event.terminRel]: "notes.md" }, subjectFiles: {} },
  ])("does not initialize an empty note without unambiguous indexed ownership: %j", async (index) => {
    if (index) files.set("/mock-vault/Sem01/.mci-manager/event-paths.json", JSON.stringify(index));
    files.set(notePath, "");

    await expect(ensureTermin(cfg, event)).rejects.toThrow("UID");
    expect(files.get(notePath)).toBe("");
    expect(calls.some(({ command }) => command === "save_text_file" || command === "ensure_dir")).toBe(false);
  });

  it.each([" ", "\n", "Personal note", "---\nuid: 42\n---\n", "---\nuid: other\n---\n", "---\nuid: [broken\n---\n"])("does not overwrite nonempty indexed notes: %j", async (raw) => {
    files.set("/mock-vault/Sem01/.mci-manager/event-paths.json", JSON.stringify({ version: 2,
      paths: { one: event.terminRel }, subjects: {}, reserved: [], files: { [event.terminRel]: "notes.md" }, subjectFiles: {} }));
    files.set(notePath, raw);

    await expect(ensureTermin(cfg, event)).rejects.toThrow();
    expect(files.get(notePath)).toBe(raw);
    expect(calls.some(({ command }) => command === "save_text_file")).toBe(false);
  });

  it("links new legacy units to their persisted shared subject MOC", async () => {
    const lecture = { ...event, uid: "lecture", typ: "VO" as const, fach: "Coding VO",
      terminRel: "02-coding-vo/2026-09-23", subjectDir: "stale-subject", subjectFile: "Stale.md" };
    files.set("/mock-vault/Sem01/.mci-manager/event-paths.json", JSON.stringify({ version: 2,
      paths: { one: event.terminRel, lecture: lecture.terminRel }, subjects: { [event.fachKey]: "07-coding" },
      reserved: [], files: {}, subjectFiles: { [event.fachKey]: "Coding Shared.md" } }));

    const exerciseNote = await ensureTermin(cfg, event);
    const lectureNote = await ensureTermin(cfg, lecture);

    expect(exerciseNote.body).toContain("[[Sem01/07-coding/Coding Shared|Fachübersicht]]");
    expect(lectureNote.body).toContain("[[Sem01/07-coding/Coding Shared|Fachübersicht]]");
    expect(lectureNote.body).not.toContain("stale-subject");
  });

  it("uses resolved subject paths for new notes before an index is available", async () => {
    const note = await ensureTermin(cfg, { ...event, subjectDir: "07-coding", subjectFile: "Coding Shared.md" });

    expect(note.body).toContain("[[Sem01/07-coding/Coding Shared|Fachübersicht]]");
  });

  it("refuses a persisted subject directory that would inject another wiki link", async () => {
    files.set("/mock-vault/Sem01/.mci-manager/event-paths.json", JSON.stringify({ version: 2,
      paths: { one: event.terminRel }, subjects: { [event.fachKey]: "01-coding]][[Phantom" },
      reserved: [], files: {}, subjectFiles: { [event.fachKey]: "Coding.md" } }));

    await expect(ensureTermin(cfg, event)).rejects.toThrow("Wikilink-Pfad");
    expect(calls.some(({ command }) => command === "save_text_file" || command === "ensure_dir")).toBe(false);
    expect(files.has(notePath)).toBe(false);
  });

  it("uses the persisted filename for reading and saving without recreating notes.md", async () => {
    const named = `/mock-vault/Sem01/${event.terminRel}/2026-09-22 1000 Coding.md`;
    files.set("/mock-vault/Sem01/.mci-manager/event-paths.json", JSON.stringify({ version: 2, paths: { one: event.terminRel }, subjects: {}, reserved: [],
      files: { [event.terminRel]: "2026-09-22 1000 Coding.md" }, subjectFiles: {} }));
    const raw = await saveTerminNote(cfg, event.terminRel, { uid: event.uid }, body, null);
    expect(files.get(named)).toBe(raw);
    expect((await readTerminNote(cfg, event.terminRel))?.raw).toBe(raw);
    expect(files.has(notePath)).toBe(false);
  });

  it("returns the exact persisted raw text with task-derived flags", async () => {
    const raw = await saveTerminNote(cfg, event.terminRel, { uid: event.uid, vorbereitet: false, nachbereitet: true }, body, null);
    const read = await readTerminNote(cfg, event.terminRel);

    expect(raw).toBe(files.get(notePath));
    expect(read).toMatchObject({ raw, body, data: { uid: event.uid, vorbereitet: true, nachbereitet: false } });
  });

  it("normalizes both status flags and returns the exact saved status revision", async () => {
    const previous = serializeNote({ uid: event.uid, vorbereitet: false, nachbereitet: true }, body);
    files.set(notePath, previous);
    const note = parseNote(previous);
    const result = await setTerminStatus(cfg, event.terminRel, note.data, note.body, "vorbereitet", false, previous);

    expect(result.raw).toBe(files.get(notePath));
    expect(result.data).toMatchObject({ vorbereitet: false, nachbereitet: false });
    expect(result.body).toBe(body.replace("[x] Read", "[ ] Read"));
  });

  it("refuses overwriting a different UID even with the current expected text", async () => {
    const raw = serializeNote({ uid: "other" }, body);
    files.set(notePath, raw);

    await expect(ensureTermin(cfg, event)).rejects.toThrow("UID");
    await expect(saveTerminNote(cfg, event.terminRel, { uid: event.uid }, body, raw)).rejects.toThrow("UID");
    expect(files.get(notePath)).toBe(raw);
    expect(calls.some(({ command }) => command === "save_text_file")).toBe(false);
  });

  it("does not claim an existing note without a UID", async () => {
    files.set(notePath, "# Personal note\n");

    await expect(ensureTermin(cfg, event)).rejects.toThrow("UID");
    expect(files.get(notePath)).toBe("# Personal note\n");
  });

  it("detects a creation race with another note", async () => {
    beforeSave = (path) => files.set(path, "external note");

    await expect(ensureTermin(cfg, event)).rejects.toBe("CONFLICT");
    expect(files.get(notePath)).toBe("external note");
  });

  it("normalizes existing flags using the exact original revision", async () => {
    const raw = serializeNote({ uid: event.uid, vorbereitet: false, nachbereitet: true, custom: { nested: ["keep"] } }, body);
    files.set(notePath, raw);
    const result = await ensureTermin(cfg, event);

    expect(result.raw).toBe(files.get(notePath));
    expect(result.status).toEqual({ vorbereitet: true, nachbereitet: false });
    expect(result.data.custom).toEqual({ nested: ["keep"] });
    expect(result.body).toBe(body);
    expect(calls.find(({ command }) => command === "save_text_file")?.args.expected).toBe(raw);
  });

  it("does not overwrite malformed frontmatter", async () => {
    const raw = "---\nuid: [broken\n---\nBody";
    files.set(notePath, raw);

    await expect(ensureTermin(cfg, event)).rejects.toThrow("YAML");
    expect(files.get(notePath)).toBe(raw);
    expect(calls.some(({ command }) => command === "save_text_file")).toBe(false);
  });
});

describe("legacy metadata migration", () => {
  it("persists the normalized note before trashing valid metadata", async () => {
    files.set(metaPath, JSON.stringify({ uid: event.uid, vorbereitet: true }));
    const result = await ensureTermin(cfg, event);

    expect(result.status).toEqual({ vorbereitet: true, nachbereitet: false });
    expect(result.raw).toBe(files.get(notePath));
    expect(files.has(metaPath)).toBe(false);
    expect(calls.filter(({ command }) => command === "save_text_file" || command === "delete_file").map(({ command }) => command)).toEqual(["save_text_file", "delete_file"]);
  });

  it.each(["{broken", "null", "[]", "{}", '{"vorbereitet":"yes"}', '{"uid":"other","vorbereitet":true}'])("preserves malformed or unrelated metadata: %s", async (meta) => {
    files.set(metaPath, meta);
    await ensureTermin(cfg, event);

    expect(files.get(metaPath)).toBe(meta);
    expect(calls.some(({ command }) => command === "delete_file")).toBe(false);
  });

  it("preserves metadata on a failed checked write", async () => {
    const meta = JSON.stringify({ vorbereitet: true });
    files.set(metaPath, meta);
    errors.set(`save_text_file:${notePath}`, "CONFLICT");

    await expect(ensureTermin(cfg, event)).rejects.toBe("CONFLICT");
    expect(files.get(metaPath)).toBe(meta);
    expect(calls.some(({ command }) => command === "delete_file")).toBe(false);
  });

  it("preserves metadata changed while the note is being saved", async () => {
    files.set(metaPath, JSON.stringify({ vorbereitet: true }));
    const updated = JSON.stringify({ vorbereitet: true, nachbereitet: true });
    beforeSave = () => files.set(metaPath, updated);
    await ensureTermin(cfg, event);

    expect(files.get(metaPath)).toBe(updated);
  });

  it("does not persist a note when reading its metadata fails", async () => {
    errors.set(`read_text_file:${metaPath}`, "EIO");

    await expect(ensureTermin(cfg, event)).rejects.toBe("EIO");
    expect(calls.some(({ command }) => command === "save_text_file")).toBe(false);
  });
});

describe("vault scaffold checked writes", () => {
  const lecture: StudyEvent = { ...event, uid: "lecture", typ: "VO", lvNummer: "2",
    terminRel: `${event.fachDir}/2026-09-23_coding-vo`, start: "2026-09-23T08:00:00.000Z", end: "2026-09-23T09:00:00.000Z" };
  const fachPath = `/mock-vault/Sem01/${event.fachDir}/Coding UE.md`;
  const lecturePath = `/mock-vault/Sem01/${event.fachDir}/Coding VO.md`;
  const secondExercise: StudyEvent = { ...event, uid: "two", lvNummer: "1-UE",
    terminRel: `${event.fachDir}/2026-09-29_coding-ue`, start: "2026-09-29T08:00:00.000Z", end: "2026-09-29T09:00:00.000Z" };

  it("creates one overview per course type with its own LV while retaining event metadata", async () => {
    await ensureVault(cfg, [event, lecture]);
    expect(files.has(notePath)).toBe(false);
    const exerciseNote = await ensureTermin(cfg, event);
    const lectureNote = await ensureTermin(cfg, lecture);
    const moc = files.get(fachPath)!;
    const lectureMoc = files.get(lecturePath)!;

    expect(parseNote(moc).data).toMatchObject({ fach: "Coding UE", typ: "UE", lv: "1" });
    expect(moc).toContain("# Coding UE\n\n[[Sem01/_Semester|Semester-Übersicht]]\n");
    expect(moc).toContain('WHERE uid AND lv = "1"\n');
    expect(moc).toContain(`[[Sem01/${event.terminRel}/notes|`);
    expect(moc).not.toContain(lecture.terminRel);
    expect(moc.split("<!-- sm:list:start -->")[1].split("<!-- sm:list:end -->")[0]).not.toContain("_Semester");
    expect(lectureMoc).toContain('WHERE uid AND lv = "2"\n');
    expect(lectureMoc).toContain(`[[Sem01/${lecture.terminRel}/notes|`);
    expect(files.get("/mock-vault/Sem01/_Semester.md")).toContain("# Semester-Übersicht\n\n[[README|Studienübersicht]]\n");
    expect(files.get("/mock-vault/Sem01/_Semester.md")).toMatch(/Coding UE[\s\S]*Coding VO/);
    expect(exerciseNote.data).toMatchObject({ typ: "UE", lv: "1" });
    expect(lectureNote.data).toMatchObject({ typ: "VO", lv: "2" });
  });

  it("adds a new course type as its own overview and leaves the existing one untouched", async () => {
    await ensureVault(cfg, [event]);
    const original = files.get(fachPath)!;
    const custom = `\n## Personal notes\nKeep this.\n\n\`\`\`\`text\n${original}\`\`\`\`\n`;
    const raw = original + custom;
    files.set(fachPath, raw);
    calls = [];

    await ensureVault(cfg, [event, lecture]);

    expect(files.get(fachPath)).toBe(raw);
    expect(files.get(lecturePath)).toContain(`[[Sem01/${lecture.terminRel}/notes|`);
    calls = [];
    await ensureVault(cfg, [event, lecture]);
    expect(calls.some(({ command }) => command === "save_text_file")).toBe(false);
  });

  it("refreshes a stale query even when the generated list is already current", async () => {
    await ensureVault(cfg, [event, secondExercise]);
    const current = files.get(fachPath)!;
    expect(current).toContain('WHERE uid AND contains(["1","1-UE"], lv)\n');
    files.set(fachPath, current.replace('contains(["1","1-UE"], lv)', 'lv = "1"'));

    await ensureVault(cfg, [event, secondExercise]);

    expect(files.get(fachPath)).toBe(current);
  });

  it("retains historical LV notes in the query when a course type changes its LV number", async () => {
    await ensureVault(cfg, [event]);
    const original = files.get(fachPath)!;
    const personal = `\nMy notes\n\n\`\`\`\`text\n${original}\`\`\`\`\n`;
    files.set(fachPath, original + personal);

    await ensureVault(cfg, [secondExercise]);
    const next = files.get(fachPath)!;

    expect(next).toContain('WHERE uid AND contains(["1","1-UE"], lv)\n');
    expect(next).toContain(`[[Sem01/${secondExercise.terminRel}/notes|`);
    expect(next.endsWith(personal)).toBe(true);
    calls = [];
    await ensureVault(cfg, [secondExercise]);
    expect(calls.some(({ command }) => command === "save_text_file")).toBe(false);
  });

  it("keeps a former course type's overview when it leaves the calendar", async () => {
    await ensureVault(cfg, [event, lecture]);
    const lectureMoc = files.get(lecturePath)!;

    await ensureVault(cfg, [event, { ...lecture, uid: "workshop", typ: "ILV", lvNummer: "3" }]);

    expect(files.get(lecturePath)).toBe(lectureMoc);
    expect(files.get(`/mock-vault/Sem01/${event.fachDir}/Coding ILV.md`)).toContain('WHERE uid AND lv = "3"\n');
  });

  it("does not merge another course ID merely because its display name and module agree", async () => {
    await ensureVault(cfg, [{ ...event, lvNummer: "MCI-B-1-COD-COD-UE" }]);

    await ensureVault(cfg, [{ ...lecture, lvNummer: "MCI-B-1-COD-OTHER-VO" }]);

    expect(files.get(fachPath)).toContain('WHERE uid AND lv = "MCI-B-1-COD-COD-UE"\n');
    expect(files.get(fachPath)).not.toContain("MCI-B-1-COD-OTHER-VO");
  });

  it("keeps custom query conditions when new sessions are synchronized", async () => {
    await ensureVault(cfg, [event]);
    const customQuery = 'WHERE uid AND lv = "1" AND vorbereitet = false';
    files.set(fachPath, files.get(fachPath)!.replace('WHERE uid AND lv = "1"', customQuery));

    await ensureVault(cfg, [event, { ...secondExercise, lvNummer: "1" }]);

    expect(files.get(fachPath)).toContain(`${customQuery}\n`);
    expect(files.get(fachPath)).toContain(`[[Sem01/${secondExercise.terminRel}/notes|`);
  });

  it("does not claim a personal MOC that only contains a fenced generated original", async () => {
    await ensureVault(cfg, [event]);
    const raw = `# Personal MOC\n\n\`\`\`\`text\n${files.get(fachPath)}\`\`\`\`\n`;
    files.set(fachPath, raw);

    await ensureVault(cfg, [event, lecture]);

    expect(files.get(fachPath)).toBe(raw);
  });

  it("retains concurrent subject edits when the generated list refresh conflicts", async () => {
    await ensureVault(cfg, [event]);
    beforeSave = (path) => { if (path === fachPath) files.set(path, "Concurrent personal edit"); };

    await expect(ensureVault(cfg, [event, { ...secondExercise, lvNummer: "1" }])).rejects.toBe("CONFLICT");
    expect(files.get(fachPath)).toBe("Concurrent personal edit");
  });

  it("uses the original MOC revision and preserves user sections", async () => {
    const path = "/mock-vault/Sem01/_Semester.md";
    const raw = "Intro\n<!-- sm:list:start -->\nOld\n<!-- sm:list:end -->\nUser notes\n";
    files.set(path, raw);
    await ensureVault(cfg, [event]);

    expect(files.get(path)).toContain("\nUser notes\n");
    expect(calls.find((call) => call.command === "save_text_file" && call.args.path === path)?.args.expected).toBe(raw);
    expect(calls.filter(({ command }) => command === "save_text_file").every(({ args }) => Object.prototype.hasOwnProperty.call(args, "expected"))).toBe(true);
  });

  it("propagates scaffold read failures without overwriting", async () => {
    errors.set("read_text_file:/mock-vault/.obsidian/app.json", "EIO");

    await expect(ensureVault(cfg, [event])).rejects.toBe("EIO");
    expect(calls.some(({ command }) => command === "save_text_file")).toBe(false);
  });
});

describe("calendar cache identity", () => {
  it("uses SHA-256 of the normalized feed URL and semester without disclosing the URL", async () => {
    const path = await calendarCachePath(cfg);
    const equivalent = await calendarCachePath({ ...cfg, icalUrl: "webcal://EXAMPLE.test:443/private-feed#ignored" });
    const otherFeed = await calendarCachePath({ ...cfg, icalUrl: "https://example.test/another-feed" });
    const otherSemester = await calendarCachePath({ ...cfg, semester: "Sem02" });

    expect(path).toMatch(/^\/mock-vault\/\.mci-manager\/calendar-[a-f0-9]{64}\.ics$/);
    expect(path).toBe(equivalent);
    expect(new Set([path, otherFeed, otherSemester]).size).toBe(3);
    expect(path).not.toContain("private-feed");
    expect(calls.some(({ command }) => command === "read_text_file")).toBe(false);
  });
});

describe("stored configuration validation", () => {
  it.each([
    "null", "[]", "42", "{broken", '{"semester":4}', '{"icalUrl":false}',
    '{"basisPfad":{}}', '{"refreshHours":"12"}', '{"lastRefresh":[]}',
    '{"semester":"../private"}', '{"refreshHours":0}',
  ])("rejects malformed settings without overwriting them: %s", async (raw) => {
    const setItem = vi.fn();
    vi.stubGlobal("localStorage", { getItem: () => raw, setItem });
    await expect(loadConfig()).rejects.toThrow("Einstellungen");
    expect(setItem).not.toHaveBeenCalled();
  });

  it("loads validated settings and uses the default basis for partial stored settings", async () => {
    vi.stubGlobal("localStorage", { getItem: () => JSON.stringify({ semester: " Sem02 ", icalUrl: "webcal://example.test/feed" }) });

    expect(await loadConfig()).toMatchObject({ basisPfad: "/mock-home/MCI", semester: "Sem02", icalUrl: "https://example.test/feed" });
  });
});
