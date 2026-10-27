import { describe, expect, it } from "vitest";
import { appointmentFileName, subjectFileName } from "../src/lib/filenames";
import { assignEventPaths, readIndex } from "../src/lib/identity";
import { buildFachMoc, fachQueryFilter, fachTerminRows, parseNote, refreshGeneratedFachQuery, replaceBetweenMarkers, serializeNote } from "../src/lib/notes";
import type { StudyEvent } from "../src/lib/types";

const event: StudyEvent = {
  uid: "one", summary: "Databases", fach: "Databases", typ: "ILV", dozent: "Example", lvNummer: "DB1",
  fachKey: "lv-db1", fachDir: "01-databases", terminRel: "01-databases/2026-10-05_databases",
  start: "2026-10-05T07:00:00.000Z", end: "2026-10-05T08:00:00.000Z",
};

describe("Obsidian filenames", () => {
  it("uses readable names without path or wikilink metacharacters", () => {
    expect(subjectFileName("  Mathematik | Zusatzprüfung [VO] / Grundlagen #1  ")).toBe("Mathematik Zusatzprüfung VO Grundlagen 1.md");
    expect(appointmentFileName("Databases", "2026-10-05", "0900")).toBe("2026-10-05 0900 Databases.md");
  });

  it("bounds Unicode filenames by UTF-8 bytes and avoids reserved names", () => {
    expect(new TextEncoder().encode(subjectFileName("🧠".repeat(300))).length).toBeLessThan(200);
    expect(subjectFileName("CON")).toBe("_CON.md");
    expect(subjectFileName("../../")).toBe("Fach.md");
  });

  it("keeps names and appointment paths stable across rescheduling and title changes", () => {
    const first = assignEventPaths(null, [], [event]);
    const next = assignEventPaths(first.raw, [], [{ ...event, fach: "New title", start: "2027-03-02T10:00:00.000Z" }]);
    expect(next.events[0]).toMatchObject({
      terminRel: first.events[0].terminRel, noteFile: "2026-10-05 0900 Databases.md", subjectFile: "Databases ILV.md",
    });
    expect(next.raw).toBe(first.raw);
  });

  it("upgrades a v1 index without moving legacy appointment directories", () => {
    const old = { version: 1, paths: { one: "01-legacy/term-a", two: "02-legacy/term-b" }, subjects: {}, reserved: [] };
    const result = assignEventPaths(JSON.stringify(old), [], [event, { ...event, uid: "two", dozent: "Second" }]);
    expect(result.events.map((e) => e.terminRel)).toEqual(["01-legacy/term-a", "02-legacy/term-b"]);
    expect(new Set(result.events.map((e) => e.subjectDir)).size).toBe(1);
    expect(readIndex(result.raw).version).toBe(2);
  });

  it("adopts an existing named note even when restoring without an index", () => {
    const result = assignEventPaths(null, [{
      terminRel: "03-legacy/term", fileName: "2026-10-05 0900 My notes.md", content: serializeNote({ uid: "one" }, "Personal notes"),
    }], [event]);
    expect(result.events[0]).toMatchObject({ terminRel: "03-legacy/term", noteFile: "2026-10-05 0900 My notes.md" });
  });

  it("allocates different MOC names when distinct subjects inherit the same directory", () => {
    const legacy = { version: 1, paths: { one: "01-legacy/a", two: "01-legacy/b" }, subjects: {}, reserved: [] };
    const result = assignEventPaths(JSON.stringify(legacy), [], [event, { ...event, uid: "two", fachKey: "lv-db2", lvNummer: "DB2" }]);
    expect(new Set(result.events.map((e) => `${e.subjectDir}/${e.subjectFile}`)).size).toBe(2);
    expect(assignEventPaths(result.raw, [], result.events).raw).toBe(result.raw);
  });

  it("keeps legacy note filenames until an explicit migration", () => {
    const result = assignEventPaths(null, [{ terminRel: "03-legacy/term", content: serializeNote({ uid: "one" }, "Personal notes") }], [event]);
    expect(result.events[0].noteFile).toBe("notes.md");
  });

  it("rejects two competing notes within one appointment directory", () => {
    const content = serializeNote({ uid: "one" }, "Personal notes");
    expect(() => assignEventPaths(null, [
      { terminRel: "03-legacy/term", content, fileName: "notes.md" },
      { terminRel: "03-legacy/term", content, fileName: "Named.md" },
    ], [event])).toThrow("mehrfach");
  });

  it.each(["../outside.md", ".hidden.md", "notes.txt", "bad#heading.md", "a/b.md"])("rejects unsafe persisted filenames: %s", (file) => {
    const index = readIndex(null);
    index.files["subject/term"] = file;
    expect(() => readIndex(JSON.stringify(index))).toThrow();
  });

  it("generates fully qualified links across legacy subject directories", () => {
    const rows = fachTerminRows([{ ...event, terminRel: "02-legacy/term", noteFile: "2026-10-05 0900 Databases.md" }], "Sem01");
    expect(rows).toContain("[[Sem01/02-legacy/term/2026-10-05 0900 Databases|");
    expect(rows).not.toContain("/notes|");
  });

  it("uses UID/LV metadata for Dataview instead of a generic filename or teacher folder", () => {
    const moc = buildFachMoc({ fach: "Databases: Advanced", typ: "ILV", dozent: "First, Second", lvBeispiel: "DB1",
      fachDir: "01-legacy", semesterPath: "Sem01", fachTag: "fach/lv-db1", semesterTag: "mci/sem01", termine: [] });
    expect(parseNote(moc).data.fach).toBe("Databases: Advanced");
    expect(moc).toContain('FROM "Sem01"\nWHERE uid AND lv = "DB1"');
    expect(moc).not.toContain('file.name = "notes"');
  });
});

describe("multi-type Fach MOCs", () => {
  const input = { fach: "Coding", typ: "VO", dozent: "Example", lvBeispiel: "CODE-VO",
    fachDir: "01-coding", semesterPath: "Sem01", fachTag: "fach/coding", semesterTag: "mci/sem01", termine: [] };
  const options = { fach: "Coding", lvNummern: ["CODE-VO", "CODE-UE"], semesterPath: "Sem01" };

  it("keeps the exact single-LV query and scalar metadata", () => {
    const moc = buildFachMoc(input);

    expect(parseNote(moc).data).toMatchObject({ fach: "Coding", typ: "VO", lv: "CODE-VO" });
    expect(moc).toContain("> VO · Example · CODE-VO\n");
    expect(moc).toContain('WHERE uid AND lv = "CODE-VO"\n');
  });

  it("represents every teaching type and distinct LV in the header, metadata and query", () => {
    const moc = buildFachMoc({ ...input, typ: "UE / VO", lvNummern: ["CODE-VO", "CODE-UE", "", "CODE-VO"] });

    expect(parseNote(moc).data).toMatchObject({ fach: "Coding", typ: "UE / VO", lv: ["CODE-UE", "CODE-VO"] });
    expect(moc).toContain("> UE / VO · Example · CODE-UE, CODE-VO\n");
    expect(moc).toContain('WHERE uid AND contains(["CODE-UE","CODE-VO"], lv)\n');
  });

  it("deduplicates LVs without turning a single LV into a list query", () => {
    expect(fachQueryFilter("Coding", ["DB1", "", "DB1"])).toBe('lv = "DB1"');
  });

  it("matches only canonical and bounded legacy subject names when no LV is available", () => {
    const moc = buildFachMoc({ ...input, typ: "UE / VO", lvBeispiel: "", lvNummern: [] });
    const filter = fachQueryFilter("Coding", []);
    const names = JSON.parse(filter.slice("contains(".length, -", fach)".length));

    expect(names).toEqual(["Coding", "Coding VO", "Coding (VO)", "Coding UE", "Coding (UE)", "Coding ILV", "Coding (ILV)"]);
    expect(moc).toContain(`WHERE uid AND ${filter}\n`);
    expect(moc).not.toContain("AND typ =");
  });

  it("escapes literal LV and subject strings in Dataview filters", () => {
    expect(fachQueryFilter("Coding", ['DB"1\\2'])).toBe('lv = "DB\\"1\\\\2"');
    expect(fachQueryFilter('Coding "A"', [])).toContain('"Coding \\"A\\" VO"');
  });

  it("refreshes the generated query without changing metadata or personal sections", () => {
    const raw = buildFachMoc(input) + "\n## My notes\nKeep this exactly.\n";
    const next = refreshGeneratedFachQuery(raw, options);

    expect(next).toBe(raw.replace('WHERE uid AND lv = "CODE-VO"', 'WHERE uid AND contains(["CODE-UE","CODE-VO"], lv)'));
    expect(refreshGeneratedFachQuery(next, options)).toBe(next);
  });

  it("refreshes an existing multi-LV query when another teaching type is added", () => {
    const raw = buildFachMoc({ ...input, lvNummern: options.lvNummern });
    const next = refreshGeneratedFachQuery(raw, { ...options, lvNummern: [...options.lvNummern, "CODE-ILV"] });

    expect(next).toContain('WHERE uid AND contains(["CODE-ILV","CODE-UE","CODE-VO"], lv)\n');
  });

  it("retains the previous exact LV when the current calendar switches teaching type", () => {
    const raw = buildFachMoc({ ...input, typ: "UE", lvBeispiel: "CODE-UE" });
    const current = { ...options, lvNummern: ["CODE-VO"] };
    const next = refreshGeneratedFachQuery(raw, current);

    expect(next).toBe(raw.replace('lv = "CODE-UE"', 'contains(["CODE-UE","CODE-VO"], lv)'));
    expect(refreshGeneratedFachQuery(next, current)).toBe(next);
  });

  it.each([
    [["CODE-UE"], '["CODE-UE","CODE-VO"]'],
    [["CODE-UE", "CODE-ILV"], '["CODE-ILV","CODE-UE","CODE-VO"]'],
    [["CODE-ILV"], '["CODE-ILV","CODE-UE","CODE-VO"]'],
  ])("preserves historical course LVs when the current list changes to %j", (lvNummern, expected) => {
    const raw = buildFachMoc({ ...input, lvNummern: ["CODE-UE", "CODE-VO"] });
    const current = { ...options, lvNummern };
    const next = refreshGeneratedFachQuery(raw, current);

    expect(next).toContain(`WHERE uid AND contains(${expected}, lv)\n`);
    expect(refreshGeneratedFachQuery(next, current)).toBe(next);
  });

  it.each([
    ['lv = "MCI-B-1-COD-OTHER-VO"'],
    ['contains(["MCI-B-1-COD-COD-VO","MCI-B-1-COD-OTHER-UE"], lv)'],
    ['lv = "MCI-B-2-COD-COD-VO"'],
  ])("preserves queries for different full course IDs despite the same subject and module: %s", (filter) => {
    const raw = buildFachMoc(input).replace('lv = "CODE-VO"', filter);

    expect(refreshGeneratedFachQuery(raw, { ...options, lvNummern: ["MCI-B-1-COD-COD-UE"] })).toBe(raw);
  });

  it("preserves custom conditions even when historical LVs belong to the current course", () => {
    const raw = buildFachMoc(input).replace('lv = "CODE-VO"', 'contains(["CODE-UE","CODE-VO"], lv) AND vorbereitet = false');

    expect(refreshGeneratedFachQuery(raw, { ...options, lvNummern: ["CODE-ILV"] })).toBe(raw);
  });

  it("replaces the legacy subject and type filter with bounded name matching", () => {
    const raw = buildFachMoc(input).replace('lv = "CODE-VO"', 'fach = "Coding VO" AND typ = "VO"');
    const next = refreshGeneratedFachQuery(raw, { ...options, lvNummern: [] });

    expect(next).toBe(raw.replace('fach = "Coding VO" AND typ = "VO"', fachQueryFilter("Coding", [])));
  });

  it("upgrades a known generated legacy folder query and preserves CRLF", () => {
    const raw = buildFachMoc(input).replace('FROM "Sem01"', 'FROM "Sem01/01-coding"')
      .replace('WHERE uid AND lv = "CODE-VO"', 'WHERE file.name = "notes"').replace(/\n/g, "\r\n");

    expect(refreshGeneratedFachQuery(raw, options)).toBe(raw.replace(
      'FROM "Sem01/01-coding"\r\nWHERE file.name = "notes"',
      'FROM "Sem01"\r\nWHERE uid AND contains(["CODE-UE","CODE-VO"], lv)',
    ));
  });

  it.each([
    ['lv = "CODE-VO"', 'lv = "CODE-VO" AND vorbereitet = false'],
    ["SORT termin ASC", "SORT termin DESC"],
    ["TABLE termin AS Termin, vorbereitet AS VB, nachbereitet AS NB", "TABLE termin, dozent"],
    ['FROM "Sem01"', 'FROM "Sem02"'],
    ['lv = "CODE-VO"', 'lv = "OTHER"'],
    ['lv = "CODE-VO"', 'fach = "Other subject" AND typ = "VO"'],
    ['lv = "CODE-VO"', 'contains(["CODE-VO","OTHER"], lv)'],
    ['lv = "CODE-VO"', 'contains([invalid], lv)'],
  ])("preserves custom queries with %s changed to %s", (before, after) => {
    const raw = buildFachMoc(input).replace(before, after);

    expect(refreshGeneratedFachQuery(raw, options)).toBe(raw);
  });

  it.each(["````text", "~~~~text"])("preserves original MOCs enclosed in %s fences", (opening) => {
    const original = `${opening}\n${buildFachMoc(input)}${opening.slice(0, 4)}\n`;
    const raw = original + buildFachMoc(input);
    const next = refreshGeneratedFachQuery(replaceBetweenMarkers(raw, "New rows").text, options);

    expect(next.startsWith(original)).toBe(true);
    expect(next.slice(original.length)).toContain("\nNew rows\n");
    expect(next.slice(original.length)).toContain('WHERE uid AND contains(["CODE-UE","CODE-VO"], lv)\n');
    expect(refreshGeneratedFachQuery(replaceBetweenMarkers(original, "New rows").text, options)).toBe(original);
  });

  it("leaves unterminated original fences unchanged", () => {
    const raw = "````text\n" + buildFachMoc(input);

    expect(refreshGeneratedFachQuery(replaceBetweenMarkers(raw, "New rows").text, options)).toBe(raw);
  });
});
