import { describe, expect, it } from "vitest";
import {
  buildFachMoc,
  buildTerminNote,
  isSafeRelativePath,
  MOC_END,
  MOC_START,
  parseNote,
  readStatus,
  replaceBetweenMarkers,
  serializeNote,
  toLocalDateKey,
  toLocalDisplay,
  toLocalTime,
  toLocalTimeKey,
  writeStatus,
} from "../src/lib/notes";

describe("YAML frontmatter preservation", () => {
  const raw = `---
# Keep this plugin configuration
uid: "event-1"
vorbereitet: false # Status comment
custom:
  nested: { title: 'a, b', enabled: true }
  links:
    - label: "First: document"
      weight: 2
  text: |
    Multiple lines
    with indentation
tags: [mci/sem01, fach/databases-ilv]
---
> Header

## Vorbereitung
- [ ] Read

## Mitschrift
Keep  these spaces.
`;

  it("round-trips an unchanged document byte for byte", () => {
    const note = parseNote(raw);

    expect(serializeNote(note.data, note.body)).toBe(raw);
  });

  it("preserves nested fields, comments and scalar styles when toggling status", () => {
    const note = parseNote(raw);
    const next = writeStatus(note.data, note.body, "vorbereitet", true);
    const saved = serializeNote(next.data, next.body);

    expect(parseNote(saved).data.custom).toEqual(note.data.custom);
    expect(saved).toContain("# Keep this plugin configuration");
    expect(saved).toContain("vorbereitet: true # Status comment");
    expect(saved).toContain('uid: "event-1"');
    expect(parseNote(saved).body).toBe(note.body.replace("- [ ] Read", "- [x] Read"));
  });

  it("preserves anchors and aliases in foreign fields", () => {
    const note = parseNote("---\nuid: one\nsettings: &settings { enabled: true }\ncopy: *settings\nvorbereitet: false\n---\nBody\n");
    const saved = serializeNote({ ...note.data, vorbereitet: true }, note.body);

    expect(saved).toContain("&settings");
    expect(saved).toContain("*settings");
    expect(parseNote(saved).data.copy).toEqual({ enabled: true });
  });

  it("preserves large foreign integer values when changing a status flag", () => {
    const note = parseNote("---\nuid: one\nvorbereitet: false\ncustom: { big: 12345678901234567890, small: 2 }\n---\nBody");
    const saved = serializeNote({ ...note.data, vorbereitet: true }, note.body);

    expect(saved).toContain("12345678901234567890");
    expect(parseNote(saved).data.custom).toEqual({ big: 12345678901234567890n, small: 2 });
  });

  it("refuses an alias side effect that would silently change foreign fields", () => {
    const note = parseNote("---\nuid: one\nvorbereitet: &status false\ncustom: { flag: *status }\n---\nBody");

    expect(() => serializeNote({ ...note.data, vorbereitet: true }, note.body)).toThrow("Datenverlust");
  });

  it("preserves CRLF body bytes while changing task checkboxes", () => {
    const note = parseNote("---\r\nuid: one\r\nvorbereitet: false\r\n---\r\n## Vorbereitung\r\n- [ ] Read\r\n\r\nTail  \r\n");
    const next = writeStatus(note.data, note.body, "vorbereitet", true);

    expect(parseNote(serializeNote(next.data, next.body)).body).toBe("## Vorbereitung\r\n- [x] Read\r\n\r\nTail  \r\n");
  });

  it.each([
    "---\nuid: one\n",
    "---",
    "---\nuid: [broken\n---\nBody",
    "---\nuid: one\nuid: two\n---\nBody",
    "---\n- list\n---\nBody",
    "---\nvalue: !custom opaque\n---\nBody",
    "---\nvalue: *missing\n---\nBody",
    "---\n? [complex, key]\n: value\n---\nBody",
  ])("refuses malformed or unsupported frontmatter without discarding it: %s", (source) => {
    expect(() => parseNote(source)).toThrow();
  });

  it("supports empty frontmatter and ordinary Markdown", () => {
    expect(parseNote("---\n---\nBody").body).toBe("Body");
    expect(parseNote("# Notes\nText")).toEqual({ data: {}, body: "# Notes\nText" });
  });

  it("keeps marker content outside the generated block unchanged", () => {
    const before = `Custom intro\r\n${MOC_START}\nold\n${MOC_END}\r\nCustom end`;

    expect(replaceBetweenMarkers(before, "new")).toEqual({
      text: `Custom intro\r\n${MOC_START}\nnew\n${MOC_END}\r\nCustom end`, changed: true,
    });
    expect(replaceBetweenMarkers("Foreign file", "new")).toEqual({ text: "Foreign file", changed: false });
  });
});

describe("Vienna date and time persistence", () => {
  it.each([
    ["2026-09-22T22:30:00.000Z", "2026-09-23", "0030", "00:30"],
    ["2026-01-22T23:30:00.000Z", "2026-01-23", "0030", "00:30"],
    ["2026-03-29T01:30:00.000Z", "2026-03-29", "0330", "03:30"],
    ["2026-10-25T01:30:00.000Z", "2026-10-25", "0230", "02:30"],
  ])("uses Europe/Vienna regardless of the host timezone for %s", (iso, date, key, time) => {
    expect([toLocalDateKey(iso), toLocalTimeKey(iso), toLocalTime(iso)]).toEqual([date, key, time]);
  });

  it("writes the Vienna day and header into new notes", () => {
    const note = parseNote(buildTerminNote({
      fach: "Coding", typ: "UE", summary: "Coding", start: "2026-09-22T22:30:00.000Z",
      end: "2026-09-22T23:30:00.000Z", dozent: "Example", uid: "one", lv: "1",
      fachTag: "fach/coding-ue", semesterTag: "mci/sem01",
      fachPath: "Sem01/07-coding/Coding.md",
    }));

    expect(note.data.termin).toBe("2026-09-23");
    expect(note.body).toContain("00:30 – 01:30");
    expect(note.body).toContain("[[Sem01/07-coding/Coding|Fachübersicht]]");
    expect(toLocalDisplay("2026-09-22T22:30:00.000Z")).toContain("23.09.");
    expect(readStatus(note.data, note.body)).toEqual({ vorbereitet: false, nachbereitet: false });
  });
});

describe("relative paths", () => {
  it.each(["../notes.md", "docs/../notes.md", "docs/./file", "docs//file", "/tmp/file", "C:relative", "C:\\file", "docs\\file", "docs/\0file", "docs/\nfile"])("rejects unsafe paths: %s", (path) => {
    expect(isSafeRelativePath(path)).toBe(false);
  });
});

describe("generated navigation links", () => {
  it.each([
    "Sem01/01-coding]][[Phantom/Coding.md", "Sem01]][[Phantom/01-coding/Coding.md",
    "Sem01/01-coding/Coding]][[Phantom.md", "Sem01/01-coding/Coding|Other.md",
    "Sem01/01-coding/Coding#Section.md", "Sem01/01-coding/Coding%20Name.md",
    "Sem01/01-coding/Coding\u202eName.md", "Sem01/../Coding.md", "Sem01/.hidden/Coding.md",
    "Sem01/01-coding/Coding.pdf", "/Sem01/01-coding/Coding.md",
  ])("rejects unsafe course link targets: %s", (fachPath) => {
    expect(() => buildTerminNote({
      fach: "Coding", typ: "UE", summary: "Coding", start: "2026-09-22T08:00:00.000Z",
      end: "2026-09-22T09:00:00.000Z", dozent: "Example", uid: "one", lv: "1",
      fachTag: "fach/coding", semesterTag: "mci/sem01", fachPath,
    })).toThrow("Wikilink-Pfad");
  });

  it.each(["Sem01]][[Phantom", "Sem01|Other", "Sem01#Section", "Sem01\u202eOther", "../Sem01"])("rejects unsafe semester breadcrumbs: %s", (semesterPath) => {
    expect(() => buildFachMoc({
      fach: "Coding", typ: "UE", dozent: "Example", lvBeispiel: "1", fachDir: "01-coding",
      semesterPath, fachTag: "fach/coding", semesterTag: "mci/sem01", termine: [],
    })).toThrow("Wikilink-Pfad");
  });
});
