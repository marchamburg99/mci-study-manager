import { describe, expect, it } from "vitest";
import { parseIcs } from "../src/lib/ical";
import { getFokus } from "../src/lib/focus";
import {
  parseNote,
  readStatus,
  serializeNote,
  isSafeRelativePath,
  writeStatus,
} from "../src/lib/notes";

const ICS = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:one@example.test
SUMMARY:Databases (ILV) - MCiT 26 (FH-Prof. Dr. Anna\\, Example)
DESCRIPTION:LV-Nummer: DB-101\\nWeitere Information
DTSTART:20261005T090000
DTEND:20261005T103000
END:VEVENT
BEGIN:VEVENT
UID:two@example.test
SUMMARY:Databases (ILV) - MCiT 26 (FH-Prof. Dr. Anna\\, Example)
DESCRIPTION:LV-Nummer: DB-101
DTSTART:20261005T110000
DTEND:20261005T123000
END:VEVENT
BEGIN:VEVENT
UID:welcome@example.test
SUMMARY:Welcome Event
DTSTART:20261001T090000
DTEND:20261001T100000
END:VEVENT
END:VCALENDAR`;

describe("iCalendar normalization", () => {
  it("parses MCI events, ignores special events and creates collision-safe folders", () => {
    const events = parseIcs(ICS);

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      fach: "Databases",
      typ: "ILV",
      dozent: "FH-Prof. Dr. Anna, Example",
      lvNummer: "DB-101",
      start: "2026-10-05T07:00:00.000Z",
      terminRel: "01-databases/2026-10-05_databases-ilv",
    });
    expect(events[1].terminRel).toBe(
      "01-databases/2026-10-05_databases-ilv-1100",
    );
  });
});

describe("study focus", () => {
  it("prefers the running event and marks a next event as soon", () => {
    const events = parseIcs(ICS);
    const now = Date.parse("2026-10-05T07:30:00.000Z");
    const focus = getFokus(events, now);

    expect(focus.laufend?.uid).toBe("one@example.test");
    expect(focus.naechstes).toBeNull();
    expect(focus.bald).toBe(false);
  });
});

describe("note status contract", () => {
  it("uses markdown tasks as the status source of truth", () => {
    const body = [
      "## Vorbereitung",
      "- [x] Gelesen",
      "- [ ] Fragen notiert",
      "```md",
      "- [ ] Ignorieren",
      "```",
      "## Nachbereitung",
      "- [x] Zusammenfassung",
    ].join("\n");

    expect(readStatus({ vorbereitet: true, nachbereitet: false }, body)).toEqual({
      vorbereitet: false,
      nachbereitet: true,
    });
  });

  it("updates flags and tasks without changing unrelated frontmatter", () => {
    const raw = serializeNote(
      { fach: "Databases", vorbereitet: false, custom: "keep" },
      "## Vorbereitung\n- [ ] Gelesen\n\n## Mitschrift\n",
    );
    const note = parseNote(raw);
    const next = writeStatus(note.data, note.body, "vorbereitet", true);

    expect(next.data).toMatchObject({ fach: "Databases", custom: "keep", vorbereitet: true });
    expect(next.body).toContain("- [x] Gelesen");
    expect(next.body).toContain("## Mitschrift");
  });
});

describe("file path safety", () => {
  it("allows document paths below docs but rejects traversal and absolute paths", () => {
    expect(isSafeRelativePath("docs/script.pdf")).toBe(true);
    expect(isSafeRelativePath("docs/../notes.md")).toBe(false);
    expect(isSafeRelativePath("/Users/example/private.txt")).toBe(false);
    expect(isSafeRelativePath("C:\\private.txt")).toBe(false);
  });
});
