import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseIcs } from "../src/lib/ical";
import { resolveEventPaths } from "../src/lib/storage";
import { serializeNote } from "../src/lib/notes";
import type { AppConfig, StudyEvent } from "../src/lib/types";

const cfg: AppConfig = { basisPfad: "/mock-vault", semester: "Sem01", icalUrl: "https://example.test/feed", refreshHours: 12, lastRefresh: null };
const root = "/mock-vault/Sem01";
const indexPath = `${root}/.mci-manager/event-paths.json`;
const ics = `BEGIN:VCALENDAR
BEGIN:VEVENT
UID:early
SUMMARY:Coding (UE) - MCiT 26 (Example)
DTSTART:20261005T090000
DTEND:20261005T100000
END:VEVENT
BEGIN:VEVENT
UID:late
SUMMARY:Coding (UE) - MCiT 26 (Example)
DTSTART:20261005T110000
DTEND:20261005T120000
END:VEVENT
END:VCALENDAR`;
let files: Map<string, string>;
let calls: Array<{ command: string; args: Record<string, unknown> }>;
let beforeSave: ((path: string) => void) | undefined;
let failure: string | null;
let discoveryOverride: Array<{ path: string; content: string }> | undefined;
let events: StudyEvent[];

beforeEach(() => {
  files = new Map();
  calls = [];
  beforeSave = undefined;
  failure = null;
  discoveryOverride = undefined;
  events = parseIcs(ics);
  vi.stubGlobal("window", {});
  mockIPC((command, payload) => {
    const args = (payload ?? {}) as Record<string, unknown>;
    calls.push({ command, args });
    if (command === failure) throw "EIO";
    const path = args.path as string;
    switch (command) {
      case "plugin:path|join": return (args.paths as string[]).join("/");
      case "read_text_file": return files.get(path) ?? null;
      case "discover_notes":
        return discoveryOverride ?? [...files].filter(([file]) => file.startsWith(`${args.dir}/`) && file.endsWith("/notes.md"))
          .map(([file, content]) => ({ path: file, content }));
      case "save_text_file":
        beforeSave?.(path);
        if ((files.get(path) ?? null) !== args.expected) throw "CONFLICT";
        files.set(path, args.content as string);
        return;
      case "ensure_dir": return;
      default: throw new Error(`Unexpected IPC command: ${command}`);
    }
  });
});

afterEach(() => {
  clearMocks();
  vi.unstubAllGlobals();
});

describe("durable calendar identity", () => {
  it("keeps indexed empty note placeholders without blocking other calendar events", async () => {
    const first = await resolveEventPaths(cfg, events);
    const notePath = `${root}/${first[0].terminRel}/${first[0].noteFile}`;
    const index = files.get(indexPath);
    files.set(notePath, "");
    discoveryOverride = [{ path: notePath, content: "" }];
    calls = [];

    expect(await resolveEventPaths(cfg, events)).toEqual(first);
    expect(files.get(indexPath)).toBe(index);
    expect(files.get(notePath)).toBe("");
    expect(calls.some(({ command }) => command === "save_text_file")).toBe(false);
    expect(await resolveEventPaths(cfg, [events[1]])).toEqual([first[1]]);
    expect(await resolveEventPaths(cfg, events)).toEqual(first);
  });

  it("keeps the later same-day event's path when the earlier event disappears", async () => {
    const first = await resolveEventPaths(cfg, events);
    const reduced = parseIcs(ics.replace(/BEGIN:VEVENT\nUID:early[\s\S]*?END:VEVENT\n/, ""));
    const next = await resolveEventPaths(cfg, reduced);

    expect(reduced[0].terminRel).toBe(first[0].terminRel);
    expect(next[0].terminRel).toBe(first[1].terminRel);
    expect(next[0].terminRel).not.toBe(first[0].terminRel);
  });

  it("does not renumber an existing subject when an alphabetically earlier subject appears", async () => {
    const first = await resolveEventPaths(cfg, events);
    const extra = parseIcs(ics.replaceAll("Coding", "Accounting").replace("UID:early", "UID:accounting-early").replace("UID:late", "UID:accounting-late"));
    const next = await resolveEventPaths(cfg, [...extra, ...events]);

    expect(next.find((event) => event.uid === "early")?.fachDir).toBe(first[0].fachDir);
    expect(next[0].fachDir).toMatch(/^02-accounting/);
    expect(next[0].fachDir).not.toBe(first[0].fachDir);
  });

  it("keeps the same UID's original path after rescheduling", async () => {
    const first = await resolveEventPaths(cfg, events);
    const rescheduled = { ...events[0], start: "2027-01-05T19:00:00.000Z", terminRel: "99-new/wrong", fachDir: "99-new" };
    const next = await resolveEventPaths(cfg, [rescheduled]);

    expect(next[0]).toMatchObject({ start: rescheduled.start, terminRel: first[0].terminRel, fachDir: first[0].fachDir });
  });

  it("reloads paths from persisted storage without an in-memory or feed cache", async () => {
    const first = await resolveEventPaths(cfg, events);
    vi.resetModules();
    const fresh = await import("../src/lib/storage");
    const next = await fresh.resolveEventPaths({ ...cfg, icalUrl: "https://example.test/replacement-feed" }, [events[1]]);

    expect(next[0].terminRel).toBe(first[1].terminRel);
    expect(calls.filter(({ command }) => command === "save_text_file")).toHaveLength(1);
  });

  it("adopts legacy notes by UID and subject tag independent of the current feed", async () => {
    const legacyRel = "07-coding-ue_example/2026-10-05_coding-ue-1100";
    const note = serializeNote({ uid: "late", tags: ["fach/coding-ue"], custom: { keep: true } }, "Personal notes\n");
    files.set(`${root}/${legacyRel}/notes.md`, note);
    const next = await resolveEventPaths(cfg, [events[1], { ...events[0], uid: "new" }]);

    expect(next[0].terminRel).toBe(legacyRel);
    expect(next[1].fachDir).toBe("07-coding-ue_example");
    expect(files.get(`${root}/${legacyRel}/notes.md`)).toBe(note);
    expect(calls.filter(({ command }) => command === "save_text_file").every(({ args }) => args.path === indexPath)).toBe(true);
  });

  it("reserves all legacy note paths even for UIDs absent from the current feed", async () => {
    const oldRel = events[0].terminRel;
    files.set(`${root}/${oldRel}/notes.md`, serializeNote({ uid: "gone", tags: ["fach/coding-ue"] }, "Old note"));
    const next = await resolveEventPaths(cfg, [events[0]]);

    expect(next[0].terminRel).not.toBe(oldRel);
    expect(JSON.parse(files.get(indexPath)!).paths.gone).toBe(oldRel);
  });

  it("never reuses a disappeared event's path even after its note has been deleted", async () => {
    const first = await resolveEventPaths(cfg, [events[0]]);
    await resolveEventPaths(cfg, []);
    const next = await resolveEventPaths(cfg, [{ ...events[0], uid: "replacement" }]);
    const returned = await resolveEventPaths(cfg, [events[0]]);

    expect(next[0].terminRel).not.toBe(first[0].terminRel);
    expect(returned[0].terminRel).toBe(first[0].terminRel);
  });

  it("reserves a note without UID permanently without adopting it", async () => {
    const oldPath = `${root}/${events[0].terminRel}/notes.md`;
    files.set(oldPath, "Personal note");
    await resolveEventPaths(cfg, []);
    files.delete(oldPath);
    const next = await resolveEventPaths(cfg, events);

    expect(next[0].terminRel).not.toBe(events[0].terminRel);
  });

  it("keeps semesters separate", async () => {
    const first = await resolveEventPaths(cfg, [events[0]]);
    const next = await resolveEventPaths({ ...cfg, semester: "Sem02" }, [{ ...events[0], uid: "different" }]);

    expect(next[0].terminRel).toBe(first[0].terminRel);
    expect(files.has("/mock-vault/Sem02/.mci-manager/event-paths.json")).toBe(true);
  });

  it("creates distinct paths for multiple UIDs at the same timestamp", async () => {
    const next = await resolveEventPaths(cfg, [events[0], { ...events[0], uid: "same-time-2" }, { ...events[0], uid: "same-time-3" }]);

    expect(new Set(next.map((event) => event.terminRel)).size).toBe(3);
  });
});

describe("identity conflicts and validation", () => {
  it.each([" ", "\n", "Personal note", "---\nuid: 42\n---\n", "---\nuid: ' '\n---\n"])("rejects nonempty indexed notes with missing or invalid UIDs and identifies their file: %j", async (content) => {
    const [event] = await resolveEventPaths(cfg, [events[0]]);
    const relative = `${event.terminRel}/${event.noteFile}`;
    const index = files.get(indexPath);
    discoveryOverride = [{ path: `${root}/${relative}`, content }];
    calls = [];

    await expect(resolveEventPaths(cfg, events)).rejects.toThrow(relative);
    expect(files.get(indexPath)).toBe(index);
    expect(calls.some(({ command }) => command === "save_text_file")).toBe(false);
  });

  it("does not adopt an empty legacy filename instead of the indexed named note", async () => {
    const [event] = await resolveEventPaths(cfg, [events[0]]);
    const index = files.get(indexPath);
    files.set(`${root}/${event.terminRel}/notes.md`, "");

    await expect(resolveEventPaths(cfg, events)).rejects.toThrow("UID");
    expect(files.get(indexPath)).toBe(index);
  });

  it("rejects duplicate discovered files even when the indexed note is empty", async () => {
    const [event] = await resolveEventPaths(cfg, [events[0]]);
    discoveryOverride = [
      { path: `${root}/${event.terminRel}/${event.noteFile}`, content: "" },
      { path: `${root}/${event.terminRel}/notes.md`, content: serializeNote({ uid: event.uid }, "Notes") },
    ];

    await expect(resolveEventPaths(cfg, events)).rejects.toThrow("mehrfach");
  });

  it("does not infer empty-note ownership from a legacy index without a filename", async () => {
    files.set(indexPath, JSON.stringify({ version: 1, paths: { early: events[0].terminRel }, subjects: {}, reserved: [] }));
    files.set(`${root}/${events[0].terminRel}/notes.md`, "");

    await expect(resolveEventPaths(cfg, events)).rejects.toThrow("UID");
  });

  it("ignores unrelated scratch Markdown, including date-prefixed names and empty UIDs", async () => {
    const first = await resolveEventPaths(cfg, [events[0]]);
    const e = first[0];
    const note = serializeNote({ uid: e.uid }, "My note");
    discoveryOverride = [
      { path: `${root}/${e.terminRel}/${e.noteFile}`, content: note },
      { path: `${root}/${e.terminRel}/2026-10-06 Scratch.md`, content: "Loose scratch notes" },
      { path: `${root}/${e.terminRel}/Empty.md`, content: serializeNote({ uid: " " }, "Scratch") },
    ];
    const next = await resolveEventPaths(cfg, [events[0]]);
    expect(next[0]).toEqual(e);
  });

  it("rejects duplicate feed UIDs explicitly", async () => {
    await expect(resolveEventPaths(cfg, [events[0], events[0]])).rejects.toThrow("doppelte");
    expect(calls.some(({ command }) => command === "save_text_file")).toBe(false);
    expect(() => parseIcs(ics.replace("UID:late", "UID:early"))).toThrow("doppelte");
  });

  it("rejects the same UID in two legacy note paths", async () => {
    const raw = serializeNote({ uid: "early" }, "Notes");
    files.set(`${root}/${events[0].terminRel}/notes.md`, raw);
    files.set(`${root}/${events[1].terminRel}/notes.md`, raw);

    await expect(resolveEventPaths(cfg, events)).rejects.toThrow("UID");
    expect(files.has(indexPath)).toBe(false);
  });

  it("refuses an indexed path occupied by a note with a different UID", async () => {
    const first = await resolveEventPaths(cfg, events);
    const index = files.get(indexPath);
    files.set(`${root}/${first[0].terminRel}/notes.md`, serializeNote({ uid: "other" }, "Foreign note"));

    await expect(resolveEventPaths(cfg, events)).rejects.toThrow("UID");
    expect(files.get(indexPath)).toBe(index);
  });

  it("rejects a persisted path shared by two UIDs", async () => {
    files.set(indexPath, JSON.stringify({ version: 1, paths: { one: "subject/termin", two: "subject/termin" }, subjects: {}, reserved: [] }));

    await expect(resolveEventPaths(cfg, events)).rejects.toThrow("UID");
  });

  it.each(["../outside", "/absolute/path", "subject/../term", "subject\\term", "subject/.hidden", "subject/term/extra"])("rejects unsafe paths from a persisted index: %s", async (path) => {
    files.set(indexPath, JSON.stringify({ version: 1, paths: { early: path }, subjects: {}, reserved: [] }));

    await expect(resolveEventPaths(cfg, events)).rejects.toThrow("Pfad");
    expect(calls.some(({ command }) => command === "save_text_file")).toBe(false);
  });

  it.each([`${root}-other/subject/term/notes.md`, `${root}/subject/../term/notes.md`, `${root}/subject/term/extra/notes.md`])("rejects invalid full paths returned by discovery: %s", async (path) => {
    discoveryOverride = [{ path, content: serializeNote({ uid: "early" }, "Notes") }];

    await expect(resolveEventPaths(cfg, events)).rejects.toThrow();
    expect(files.has(indexPath)).toBe(false);
  });

  it.each(["{broken", '{"version":2}', '{"version":1,"paths":{},"subjects":{},"reserved":["../old"]}'])("does not replace a corrupted index: %s", async (raw) => {
    files.set(indexPath, raw);

    await expect(resolveEventPaths(cfg, events)).rejects.toThrow();
    expect(files.get(indexPath)).toBe(raw);
  });

  it("preserves the competing index on a checked-write conflict", async () => {
    beforeSave = (path) => files.set(path, "concurrent revision");

    await expect(resolveEventPaths(cfg, events)).rejects.toBe("CONFLICT");
    expect(files.get(indexPath)).toBe("concurrent revision");
    expect(calls.filter(({ command }) => command === "save_text_file")).toHaveLength(1);
  });

  it.each(["read_text_file", "discover_notes"])("does not write after an IPC failure in %s", async (command) => {
    failure = command;

    await expect(resolveEventPaths(cfg, events)).rejects.toBe("EIO");
    expect(calls.some(({ command: called }) => called === "save_text_file")).toBe(false);
  });
});
