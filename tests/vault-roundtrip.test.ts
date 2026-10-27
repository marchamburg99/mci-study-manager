import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseIcs } from "../src/lib/ical";
import { buildFachMoc, serializeNote } from "../src/lib/notes";
import { planVaultMigration } from "../src/lib/vaultMigration";
import { ensureVault, readTerminNote, resolveEventPaths, saveTerminNote } from "../src/lib/storage";

afterEach(() => { clearMocks(); vi.unstubAllGlobals(); });

describe("migrated vault application roundtrip", () => {
  it.each([false, true])("syncs and edits migrated notes without duplicate overviews or moved UIDs (mixed types: %s)", async (mixed) => {
    const cfg = { basisPfad: "/mock", semester: "Sem01", icalUrl: "https://example.test/feed", refreshHours: 12, lastRefresh: null };
    const feed = `BEGIN:VCALENDAR
BEGIN:VEVENT
UID:one
SUMMARY:Databases (ILV) - MCiT 26 (First)
DESCRIPTION:LV-Nummer: DB1
DTSTART:20261005T090000
DTEND:20261005T100000
END:VEVENT
BEGIN:VEVENT
UID:two
SUMMARY:Geleitetes Selbststudium Databases (ILV) - MCiT 26 (Second)
DESCRIPTION:LV-Nummer: DB1
DTSTART:20261006T090000
DTEND:20261006T100000
END:VEVENT
END:VCALENDAR`;
    const events = parseIcs(mixed ? feed.replaceAll("Databases", "Coding")
      .replace("Coding (ILV)", "Coding UE (UE)").replace("Geleitetes Selbststudium Coding (ILV)", "Coding VO (VO)")
      .replace("DB1", "MCI-B-1-COD-COD-UE").replace("DB1", "MCI-B-1-COD-COD-VO") : feed);
    const indexPath = "Sem01/.mci-manager/event-paths.json";
    const note = serializeNote({ uid: "one", fach: events[0].fach, typ: events[0].typ, lv: events[0].lvNummer,
      vorbereitet: true, custom: { keep: true } }, "My notes\n");
    const original = new Map([
      [indexPath, JSON.stringify({ version: 1, paths: { one: "01-first/day", two: "02-second/day" }, subjects: {}, reserved: [] })],
      ["Sem01/01-first/day/notes.md", note],
      ["Sem01/01-first/_Fach.md", buildFachMoc({ fach: "Databases", typ: "ILV", dozent: "First", lvBeispiel: "DB1",
        fachDir: "01-first", semesterPath: "Sem01", fachTag: "fach/old", semesterTag: "mci/sem01", termine: [] })],
    ]);
    if (mixed) {
      original.delete("Sem01/01-first/_Fach.md");
      original.delete("Sem01/01-first/day/notes.md");
      original.set("Sem01/01-first/day/Personal.md", note);
      original.set(indexPath, JSON.stringify({ version: 2, paths: { one: "01-first/day", two: "02-second/day" },
        subjects: { ue: "01-first", vo: "02-second" }, reserved: ["01-first/day", "02-second/day"],
        files: { "01-first/day": "Personal.md" }, subjectFiles: { ue: "Coding UE.md", vo: "Coding VO.md" } }));
      events.forEach((event, i) => original.set(`Sem01/${i ? "02-second" : "01-first"}/Coding ${event.typ}.md`,
        buildFachMoc({ fach: `Coding ${event.typ}`, typ: event.typ, dozent: event.dozent, lvBeispiel: event.lvNummer,
          fachDir: "unused", semesterPath: "Sem01", fachTag: `fach/${event.typ.toLowerCase()}`, semesterTag: "mci/sem01", termine: [] })));
    }
    const plan = planVaultMigration({ files: original, events, semester: "Sem01" });
    const files = new Map([...plan.files].map(([path, content]) => [`/mock/${path}`, content]));
    vi.stubGlobal("window", {});
    mockIPC((command, payload) => {
      const args = (payload ?? {}) as Record<string, unknown>;
      const path = args.path as string;
      switch (command) {
        case "plugin:path|join": return (args.paths as string[]).join("/");
        case "read_text_file": return files.get(path) ?? null;
        case "discover_notes": return [...files].filter(([file]) => file.startsWith(`${args.dir}/`) && file.endsWith(".md")
          && file.slice(String(args.dir).length + 1).split("/").length === 3).map(([file, content]) => ({ path: file, content }));
        case "ensure_dir": return;
        case "save_text_file":
          if ((files.get(path) ?? null) !== args.expected) throw "CONFLICT";
          files.set(path, args.content as string);
          return;
        default: throw new Error(`Unexpected IPC: ${command}`);
      }
    });
    const resolved = await resolveEventPaths(cfg, events);
    await ensureVault(cfg, resolved);
    await ensureVault(cfg, await resolveEventPaths(cfg, events));
    const synced = JSON.parse(files.get(`/mock/${indexPath}`)!);
    expect([synced.paths, synced.files]).toEqual([plan.index.paths, plan.index.files]);
    if (!mixed) {
      // A single-type subject keeps folder and overview; only its index key gains the course type.
      expect([synced.subjects, synced.subjectFiles]).toEqual([
        { [`${events[0].fachKey}-ilv`]: "01-first" }, { [`${events[0].fachKey}-ilv`]: "Databases.md" }]);
    }
    expect(resolved.map((event) => event.terminRel)).toEqual(["01-first/day", "02-second/day"]);
    const loaded = await readTerminNote(cfg, resolved[0].terminRel);
    expect(loaded?.raw).toBe(note);
    await saveTerminNote(cfg, resolved[0].terminRel, loaded!.data, "Edited notes\n", loaded!.raw);
    expect((await readTerminNote(cfg, resolved[0].terminRel))?.data.custom).toEqual({ keep: true });
    expect([...files.keys()].some((path) => path.endsWith("/notes.md") || path.endsWith("/_Fach.md"))).toBe(false);
    if (mixed) {
      // UE and VO of one subject get separate folders and overviews (decision D2).
      expect(resolved.map((event) => event.fachKey)).toEqual([events[0].fachKey, events[0].fachKey]);
      expect(resolved.map((event) => `${event.subjectDir}/${event.subjectFile}`)).toEqual(["01-first/Coding UE.md", "02-second/Coding VO.md"]);
      expect(files.get("/mock/Sem01/01-first/Coding UE.md")).toContain('WHERE uid AND lv = "MCI-B-1-COD-COD-UE"');
      expect(files.get("/mock/Sem01/02-second/Coding VO.md")).toContain('WHERE uid AND lv = "MCI-B-1-COD-COD-VO"');
    }
  });
});
