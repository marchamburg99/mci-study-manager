// @vitest-environment happy-dom
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useNoteEditor } from "../src/hooks/useNoteEditor";
import { draftKey } from "../src/lib/drafts";
import { parseNote, serializeNote } from "../src/lib/notes";
import type { AppConfig, StudyEvent } from "../src/lib/types";

const cfg: AppConfig = {
  basisPfad: "/mock-vault", semester: "Sem01", icalUrl: "https://example.test/calendar", refreshHours: 12, lastRefresh: null,
};
const event: StudyEvent = {
  uid: "one", fach: "Coding", typ: "UE", summary: "Coding", dozent: "Example", lvNummer: "1",
  start: "2026-09-22T08:00:00.000Z", end: "2026-09-22T09:00:00.000Z",
  fachKey: "coding-ue", fachDir: "01-coding", terminRel: "01-coding/2026-09-22_coding-ue", noteFile: "2026-09-22 1000 Coding.md",
};
const indexPath = "/mock-vault/Sem01/.mci-manager/event-paths.json";
const notePath = `/mock-vault/Sem01/${event.terminRel}/${event.noteFile}`;
let root: Root;
let container: HTMLDivElement;
let latest: ReturnType<typeof useNoteEditor>;
let files: Map<string, string>;
let writes: Array<Record<string, unknown>>;
let beforeSave: (() => void) | undefined;

function Probe() {
  const api = useNoteEditor(cfg, event);
  useEffect(() => { latest = api; }, [api]);
  return null;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("isTauri", false);
  localStorage.clear();
  files = new Map([
    [indexPath, JSON.stringify({ version: 2, paths: { one: event.terminRel }, subjects: {}, reserved: [],
      files: { [event.terminRel]: event.noteFile }, subjectFiles: {} })],
    [notePath, ""],
  ]);
  writes = [];
  beforeSave = undefined;
  mockIPC((command, payload) => {
    const args = (payload ?? {}) as Record<string, unknown>;
    const path = args.path as string;
    switch (command) {
      case "plugin:path|join": return (args.paths as string[]).join("/");
      case "read_text_file": return files.get(path) ?? null;
      case "save_text_file":
        writes.push(args);
        beforeSave?.();
        if ((files.get(path) ?? null) !== args.expected) throw "CONFLICT";
        files.set(path, args.content as string);
        return;
      case "ensure_dir": return;
      default: throw new Error(`Unexpected IPC command: ${command}`);
    }
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  localStorage.clear();
  clearMocks();
  vi.unstubAllGlobals();
});

describe("indexed empty notes in the editor", () => {
  it("offers explicit creation without writing on open and saves later edits normally", async () => {
    await act(async () => root.render(createElement(Probe)));

    expect(latest).toMatchObject({ loaded: false, canCreate: true,
      readError: "Für diesen Termin wurde noch keine Notiz angelegt." });
    expect(files.get(notePath)).toBe("");
    expect(writes).toHaveLength(0);

    await act(async () => latest.create());
    const created = files.get(notePath)!;

    expect(latest).toMatchObject({ loaded: true, canCreate: false, readError: null, data: { uid: event.uid } });
    expect(writes[0]).toMatchObject({ path: notePath, expected: "" });
    await act(async () => latest.editor.edit(`${latest.body}\nPersonal notes`));
    await act(async () => latest.editor.save());
    expect(writes[1]).toMatchObject({ path: notePath, expected: created });
    expect(parseNote(files.get(notePath)!).body).toContain("Personal notes");
  });

  it("preserves content entered externally between opening and explicit creation", async () => {
    await act(async () => root.render(createElement(Probe)));
    files.set(notePath, "Personal note created in Obsidian");

    await act(async () => latest.create());

    expect(files.get(notePath)).toBe("Personal note created in Obsidian");
    expect(latest.readError).toContain("UID");
    expect(writes).toHaveLength(0);
  });

  it("keeps the competing content when explicit creation loses a checked-write race", async () => {
    await act(async () => root.render(createElement(Probe)));
    beforeSave = () => files.set(notePath, "Concurrent personal note");

    await act(async () => latest.create());

    expect(files.get(notePath)).toBe("Concurrent personal note");
    expect(latest.readError).toContain("CONFLICT");
    expect(writes[0]).toMatchObject({ path: notePath, expected: "" });
  });

  it.each([" ", "\n", "Personal note", "---\nuid: other\n---\n", "---\nuid: [broken\n---\n"])("keeps nonempty indexed notes blocked: %j", async (raw) => {
    files.set(notePath, raw);

    await act(async () => root.render(createElement(Probe)));
    await act(async () => latest.create());

    expect(latest).toMatchObject({ loaded: false, canCreate: false });
    expect(files.get(notePath)).toBe(raw);
    expect(writes).toHaveLength(0);
  });

  it("does not offer creation for an empty legacy note without an index", async () => {
    files.delete(indexPath);
    files.set(`/mock-vault/Sem01/${event.terminRel}/notes.md`, "");

    await act(async () => root.render(createElement(Probe)));
    await act(async () => latest.create());

    expect(latest).toMatchObject({ loaded: false, canCreate: false });
    expect(latest.readError).toContain("UID");
    expect(writes).toHaveLength(0);
  });

  it("preserves a recovered draft when its indexed file has become empty", async () => {
    const key = draftKey({ ...cfg, uid: event.uid, terminRel: event.terminRel });
    const draft = JSON.stringify({ version: 1, revision: "recovered", baseRaw: serializeNote({ uid: event.uid }, "Original"),
      body: "Recovered personal notes", status: { vorbereitet: false, nachbereitet: false } });
    localStorage.setItem(key, draft);

    await act(async () => root.render(createElement(Probe)));
    await act(async () => latest.create());
    await act(async () => latest.editor.keepMine());

    expect(latest).toMatchObject({ body: "Recovered personal notes", dirty: true, canCreate: false, conflict: { raw: null } });
    expect(files.get(notePath)).toBe("");
    expect(localStorage.getItem(key)).toBe(draft);
    expect(writes).toHaveLength(0);
  });

  it("does not recreate a note that became empty after it was loaded", async () => {
    files.set(notePath, serializeNote({ uid: event.uid }, "Original"));
    await act(async () => root.render(createElement(Probe)));
    files.set(notePath, "");

    await act(async () => latest.editor.refresh());
    await act(async () => latest.create());

    expect(latest.canCreate).toBe(false);
    expect(latest.readError).toContain("fehlt");
    expect(files.get(notePath)).toBe("");
    expect(writes).toHaveLength(0);
  });
});
