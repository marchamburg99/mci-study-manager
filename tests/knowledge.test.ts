import { describe, expect, it } from "vitest";
import {
  MAX_KNOWLEDGE_BYTES,
  knowledgePath,
  parseKnowledgeNote,
  resolveKnowledgeLink,
  sourceUrl,
  subjectKnowledgePaths,
  upcomingKnowledge,
  upcomingExams,
  type KnowledgeNote,
  type KnowledgeNotice,
} from "../src/lib/knowledge";
import type { StudyEvent } from "../src/lib/types";

const source = "https://example.test/sakai/course";
const notePath = "Sem01/07-coding/Coding - Sakai.md";
const confirmed = {
  id: "assignment", titel: "Example assignment", zeitpunkt: "2026-09-23T10:00:00+02:00",
  art: "frist", quelle: source, bestaetigt: true,
};
const confirmedExam = {
  id: "communication-assignment", titel: "Assignment 1+2", datum: "2026-11-19",
  bereich: "pruefung", art: "frist", quelle: source, bestaetigt: true,
};
const event: StudyEvent = {
  uid: "example-ue", summary: "Coding UE", fach: "Coding", typ: "UE", dozent: "Example", lvNummer: "CODE-UE",
  fachKey: "coding", fachDir: "02-legacy-ue", terminRel: "02-legacy-ue/term",
  subjectDir: "07-coding", subjectFile: "Coding.md",
  start: "2026-09-22T08:00:00.000Z", end: "2026-09-22T09:00:00.000Z",
};

function markdown(data: Record<string, unknown>, body = "# Example knowledge\n") {
  return `---\n${JSON.stringify(data)}\n---\n${body}`;
}

function withNotices(notices: KnowledgeNotice[], path = notePath): KnowledgeNote {
  return {
    path, title: "Example knowledge", body: "", subjectKey: null, subject: null, retrievedAt: null,
    sourceStatus: null, applicability: null, cohort: null, sourceUrls: [source], notices,
  };
}

describe("parseKnowledgeNote", () => {
  it("reads source metadata and explicitly confirmed notices without adding event identity", () => {
    const body = "# Course knowledge\n\nKeep  these spaces.\n";
    const raw = `---
fach: Coding
abgerufen: 2026-09-22
quellenstand: " Locally reviewed "
geltung: " Example cohort "
jahrgang: 2026
source_urls:
  - ${source}
  - ${source}
  - https://example.test/sakai/resources
  - javascript:alert(1)
source_url: ${source}
hinweise:
  - id: assignment
    titel: Example assignment
    zeitpunkt: 2026-09-23T10:00:00+02:00
    art: frist
    quelle: ${source}
    bestaetigt: true
---
${body}`;

    expect(parseKnowledgeNote(raw, notePath, "coding")).toEqual({
      path: notePath, title: "Course knowledge", body, subjectKey: "coding", subject: "Coding",
      retrievedAt: "2026-09-22", sourceStatus: "Locally reviewed", applicability: "Example cohort", cohort: 2026,
      sourceUrls: [source, "https://example.test/sakai/resources"],
      notices: [{ id: "assignment", title: "Example assignment", at: confirmed.zeitpunkt, kind: "frist", sourceUrl: source }],
    });
  });

  it("reads group and semester metadata for confirmed date-only exams without inventing a time", () => {
    const raw = markdown({
      source_url: source, gruppe: " IM ", pruefungssemester: " Sem01 ",
      hinweise: [{ ...confirmedExam, detail: " Assignment 1 and 2 are due together. " }],
    });

    expect(parseKnowledgeNote(raw, notePath)).toMatchObject({
      group: "IM", examSemester: "Sem01",
      notices: [{
        id: confirmedExam.id, title: confirmedExam.titel, at: "2026-11-19", kind: "frist",
        category: "pruefung", sourceUrl: source, detail: "Assignment 1 and 2 are due together.",
      }],
    });
  });

  it("keeps a confirmed exam time and a date range as distinct representations", () => {
    const raw = markdown({ source_url: source, pruefungssemester: "Sem01", hinweise: [
      { ...confirmed, bereich: "pruefung" },
      { ...confirmedExam, bis: "2026-11-21", art: "termin" },
    ] });

    expect(parseKnowledgeNote(raw, notePath)?.notices).toEqual([
      { id: confirmed.id, title: confirmed.titel, at: confirmed.zeitpunkt, kind: "frist", category: "pruefung", sourceUrl: source },
      { id: confirmedExam.id, title: confirmedExam.titel, at: "2026-11-19", endDate: "2026-11-21", kind: "termin", category: "pruefung", sourceUrl: source },
    ]);
  });

  it.each([
    { datum: "2026-02-29" }, { datum: "2026-04-31" }, { datum: "2026-13-01" },
    { datum: "2026-11-19T00:00:00Z" }, { datum: 20261119 }, { datum: "" },
    { bis: "2026-11-18" }, { bis: "2026-11-31" }, { bis: "2026-11-21T00:00:00Z" },
    { bis: null }, { detail: 123 }, { detail: {} }, { art: "hinweis" }, { bereich: "exam" },
    { zeitpunkt: "2026-11-19T13:15:00+01:00" },
  ])("rejects malformed confirmed exam fields instead of silently changing their meaning: %j", (fields) => {
    const raw = markdown({ source_url: source, pruefungssemester: "Sem01", hinweise: [{ ...confirmedExam, ...fields }] });

    expect(() => parseKnowledgeNote(raw, notePath)).toThrow();
  });

  it("rejects a confirmed exam without either a date or a time", () => {
    const raw = markdown({ source_url: source, pruefungssemester: "Sem01", hinweise: [{ ...confirmedExam, datum: undefined }] });

    expect(() => parseKnowledgeNote(raw, notePath)).toThrow();
  });

  it("rejects a date range attached to an exact exam time", () => {
    const raw = markdown({ source_url: source, pruefungssemester: "Sem01", hinweise: [{ ...confirmed, bereich: "pruefung", bis: "2026-09-24" }] });

    expect(() => parseKnowledgeNote(raw, notePath)).toThrow();
  });

  it.each([{ datum: "2026-11-19" }, { bis: "2026-11-20" }, { detail: "Exam only" }, { bereich: "assignment" }])(
    "does not apply exam-only fields to generic notices: %j", (fields) => {
      const raw = markdown({ source_url: source, pruefungssemester: "Sem01", hinweise: [{ ...confirmed, ...fields }] });

      expect(() => parseKnowledgeNote(raw, notePath)).toThrow();
    },
  );

  it("requires exam source proof and ignores unconfirmed exam dates", () => {
    const raw = markdown({ source_url: source, pruefungssemester: "Sem01", hinweise: [{ ...confirmedExam, bestaetigt: false, datum: "invalid" }] });

    expect(parseKnowledgeNote(raw, notePath)?.notices).toEqual([]);
    expect(() => parseKnowledgeNote(markdown({ pruefungssemester: "Sem01", hinweise: [confirmedExam] }), notePath)).toThrow();
    expect(() => parseKnowledgeNote(markdown({ source_url: source, pruefungssemester: "Sem01", hinweise: [{ ...confirmedExam, quelle: "https://example.test/unlisted" }] }), notePath)).toThrow();
  });

  it.each(["2024-02-29", "2000-02-29", "2026-11-19"])("preserves real date-only exam dates including leap years: %s", (datum) => {
    const raw = markdown({ source_url: source, pruefungssemester: "Sem01", hinweise: [{ ...confirmedExam, datum, bis: datum }] });

    expect(parseKnowledgeNote(raw, notePath)?.notices[0]).toMatchObject({ at: datum, endDate: datum, category: "pruefung" });
  });

  it.each([undefined, null, "", "  "])("requires semester attribution for a confirmed exam: %j", (pruefungssemester) => {
    const raw = markdown({ source_url: source, pruefungssemester, hinweise: [confirmedExam] });

    expect(() => parseKnowledgeNote(raw, notePath)).toThrow();
  });

  it("does not infer notices from prose, tables, links, or event-like metadata", () => {
    const body = "# Dates\nDeadline: 2026-09-23T10:00:00+02:00.\n"
      + "| Exam | 24.09.2026 |\n[Registration](https://example.test/2026-09-25)\nuid: prose-only\n";
    const raw = markdown({ termin: "2026-09-23", start: confirmed.zeitpunkt, deadline: "2026-09-24", source_url: source }, body);

    expect(parseKnowledgeNote(raw, notePath)).toMatchObject({ body, notices: [] });
  });

  it.each(["event@example.test", "", null, false, 0, []])("excludes appointment notes with any UID value: %j", (uid) => {
    expect(parseKnowledgeNote(markdown({ uid, hinweise: "invalid" }), notePath)).toBeNull();
  });

  it.each([undefined, false, "true", "yes", 1, null])("ignores notices without boolean confirmation: %j", (bestaetigt) => {
    const raw = markdown({ source_url: source, hinweise: [{ ...confirmed, bestaetigt, zeitpunkt: "invalid", quelle: "invalid" }] });

    expect(parseKnowledgeNote(raw, notePath)?.notices).toEqual([]);
  });

  it.each(["termin", "frist", "hinweis"])("accepts the confirmed notice kind %s", (art) => {
    const raw = markdown({ source_url: source, hinweise: [{ ...confirmed, art }] });

    expect(parseKnowledgeNote(raw, notePath)?.notices).toEqual([
      { id: confirmed.id, title: confirmed.titel, at: confirmed.zeitpunkt, kind: art, sourceUrl: source },
    ]);
  });

  it.each([
    { id: "" }, { id: 4 }, { titel: "  " }, { titel: null }, { art: "exam" },
    { quelle: "https://example.test/unlisted" }, { quelle: "http://example.test/sakai/course" }, { quelle: null },
  ])("rejects invalid confirmed fields: %j", (fields) => {
    const raw = markdown({ source_url: source, hinweise: [{ ...confirmed, ...fields }] });

    expect(() => parseKnowledgeNote(raw, notePath)).toThrow("Bestätigter Hinweis");
  });

  it("requires a confirmed source to be listed in the note metadata", () => {
    expect(() => parseKnowledgeNote(markdown({ hinweise: [confirmed] }), notePath)).toThrow("Quelle der Notiz");
  });

  it("rejects duplicate confirmed IDs while ignoring an unconfirmed duplicate", () => {
    const raw = markdown({ source_url: source, hinweise: [confirmed, { ...confirmed, bestaetigt: false }] });

    expect(parseKnowledgeNote(raw, notePath)?.notices).toHaveLength(1);
    expect(() => parseKnowledgeNote(markdown({ source_url: source, hinweise: [confirmed, confirmed] }), notePath)).toThrow("eindeutige ID");
  });

  it.each([null, {}, "prose", [null], ["prose"], [[]]])("rejects malformed notice collections: %j", (hinweise) => {
    expect(() => parseKnowledgeNote(markdown({ hinweise }), notePath)).toThrow();
  });

  it("accepts 50 notices and rejects a collection exceeding the limit", () => {
    const hinweise = Array.from({ length: 50 }, (_, index) => ({ ...confirmed, id: `notice-${index}` }));

    expect(parseKnowledgeNote(markdown({ source_url: source, hinweise }), notePath)?.notices).toHaveLength(50);
    expect(() => parseKnowledgeNote(markdown({ source_url: source, hinweise: [...hinweise, { ...confirmed, id: "overflow" }] }), notePath))
      .toThrow("Format");
  });

  it.each([
    "2026-02-29T12:00:00Z", "2026-02-30T12:00:00Z", "2026-04-31T12:00:00Z", "2100-02-29T12:00:00Z",
    "2026-00-10T12:00:00Z", "2026-13-01T12:00:00Z", "2026-09-00T12:00:00Z",
    "2026-09-23", "2026-09-23T10:00:00", "2026-09-23T24:00:00Z", "2026-09-23T10:60:00Z",
    "2026-09-23T10:00:60Z", "2026-09-23T10:00:00+15:00", "2026-09-23T10:00:00+02:60",
    "2026-09-23T10:00:00+0200", "2026-09-23T10:00:00 Europe/Vienna",
    "2026-09-23T10:00:00+14:01", "2026-09-23T10:00:00-14:59",
  ])("rejects invalid calendar dates, times, and offsets: %s", (zeitpunkt) => {
    const raw = markdown({ source_url: source, hinweise: [{ ...confirmed, zeitpunkt }] });

    expect(() => parseKnowledgeNote(raw, notePath)).toThrow("Datum mit Zeitzone");
  });

  it.each([
    "2024-02-29T12:00:00Z", "2000-02-29T12:00:00Z", "2026-09-23T00:00Z",
    "2026-09-23T23:59:59+02:00", "2026-09-23T10:00:00-03:30",
    "2026-09-23T10:00:00+14:00", "2026-09-23T10:00:00-14:00",
  ])("preserves valid leap days and zoned timestamps: %s", (zeitpunkt) => {
    const raw = markdown({ source_url: source, hinweise: [{ ...confirmed, zeitpunkt }] });

    expect(parseKnowledgeNote(raw, notePath)?.notices[0].at).toBe(zeitpunkt);
  });

  it.each(["2026-02-29", "2026-04-31", "2026-13-01", "2026-09-22T00:00:00Z", 20260922])("does not present an invalid retrieval date as trusted: %j", (abgerufen) => {
    expect(parseKnowledgeNote(markdown({ abgerufen }), notePath)?.retrievedAt).toBeNull();
  });

  it.each(["2024-02-29", "2000-02-29", "2026-09-22"])("accepts a real retrieval date: %s", (abgerufen) => {
    expect(parseKnowledgeNote(markdown({ abgerufen }), notePath)?.retrievedAt).toBe(abgerufen);
  });

  it.each([1999, 2101, 2026.5, "2026", null])("does not coerce an invalid cohort: %j", (jahrgang) => {
    expect(parseKnowledgeNote(markdown({ jahrgang }), notePath)?.cohort).toBeNull();
  });

  it("uses the filename for untitled Markdown and leaves absent metadata empty", () => {
    expect(parseKnowledgeNote("Plain text\n", "Studium/General notes.md")).toEqual({
      path: "Studium/General notes.md", title: "General notes", body: "Plain text\n", subjectKey: null,
      subject: null, retrievedAt: null, sourceStatus: null, applicability: null, cohort: null, sourceUrls: [], notices: [],
    });
  });

  it.each(["---\nfach: [broken\n---\nBody", "---\nfach: One\nfach: Two\n---\nBody"])("rejects malformed frontmatter: %s", (raw) => {
    expect(() => parseKnowledgeNote(raw, notePath)).toThrow();
  });

  it("enforces the file limit in UTF-8 bytes including the boundary", () => {
    const raw = "é".repeat(MAX_KNOWLEDGE_BYTES / 2);

    expect(parseKnowledgeNote(raw, notePath)?.body).toBe(raw);
    expect(() => parseKnowledgeNote(`${raw}a`, notePath)).toThrow("zu groß");
  });
});

describe("sourceUrl", () => {
  it("canonicalizes HTTPS URLs before matching and deduplicating sources", () => {
    const raw = markdown({ source_urls: ["https://EXAMPLE.test:443/sakai/course", source], hinweise: [confirmed] });

    expect(sourceUrl("https://EXAMPLE.test:443/sakai/course")).toBe(source);
    expect(parseKnowledgeNote(raw, notePath)).toMatchObject({ sourceUrls: [source], notices: [{ sourceUrl: source }] });
  });

  it.each([
    null, 42, "", "/sakai/course", "//example.test/sakai/course", "http://example.test/course",
    "javascript:alert(1)", "data:text/html,example", "file:///synthetic/note.md", "obsidian://open",
    "https://user:password@example.test/course", `https://example.test/${"a".repeat(4096)}`,
  ])("rejects unsafe or unsupported source URLs: %.80s", (url) => {
    expect(sourceUrl(url)).toBeNull();
  });
});

describe("knowledgePath", () => {
  it.each([notePath, "Studium/General notes.md", "Sem01/07-coding/docs/Übung 1.pdf"])("preserves safe vault-relative paths: %s", (path) => {
    expect(knowledgePath(path)).toBe(path);
  });

  it.each([
    "", "../outside.md", "Studium/../outside.md", "Studium/./note.md", "Studium//note.md", "Studium/",
    "/synthetic/outside.md", "//example.test/note.md", "C:/outside.md", "C:outside.md", "docs\\note.md",
    "https://example.test/note.md", "javascript:alert(1)", "file:///synthetic/note.md", "obsidian://open",
    ".hidden/note.md", "Studium/.hidden.md", " Studium/note.md", "Studium /note.md", "Studium/note.md ",
    "Studium/%2e%2e/note.md", "Studium/%252e%252e/note.md", "Studium/Note%20name.md",
    "Studium/note.md#heading", "Studium/note.md?query", "Studium/note|alias.md", "Studium/\0note.md",
    "Studium/\nnote.md", "Studium/\u007fnote.md",
  ])("rejects unsafe paths before parsing: %s", (path) => {
    expect(() => knowledgePath(path)).toThrow();
    expect(() => parseKnowledgeNote("# Example", path)).toThrow();
  });
});

describe("resolveKnowledgeLink", () => {
  it.each([
    ["#Resources", { path: notePath, heading: "Resources" }],
    ["Studium/General notes#Dates", { path: "Studium/General notes.md", heading: "Dates" }],
    ["Studium/General%20notes.md", { path: "Studium/General notes.md", heading: null }],
    ["docs/Reading%20list.pdf", { path: "Sem01/07-coding/docs/Reading list.pdf", heading: null }],
    ["docs/Exercises#Task 1", { path: "Sem01/07-coding/docs/Exercises.md", heading: "Task 1" }],
  ])("resolves local links and heading fragments: %s", (target, expected) => {
    expect(resolveKnowledgeLink(target, notePath)).toEqual(expected);
  });

  it.each([
    "../outside", "docs/../../outside.md", "docs/%2e%2e/outside.md", "%2e%2e/outside.md",
    "%252e%252e/outside.md", "%2Fsynthetic/outside.md", "docs%2F..%2Foutside.md", "docs/%5coutside.md",
    "https%3A%2F%2Fexample.test/note.md", "https://example.test/note.md", "javascript:alert(1)",
    "file:///synthetic/note.md", "/synthetic/note.md", "C:\\note.md", "//example.test/note.md",
    "docs/note%23heading.md", "docs/%00note.md", "docs/%ZZ.md", "docs/note.md?download=1",
  ])("rejects unsafe and encoded link targets: %s", (target) => {
    expect(() => resolveKnowledgeLink(target, notePath)).toThrow();
  });

  it("validates the current path when resolving a heading-only link", () => {
    expect(() => resolveKnowledgeLink("#Resources", "../outside.md")).toThrow();
  });
});

describe("subjectKnowledgePaths", () => {
  const lecture: StudyEvent = {
    ...event, uid: "example-vo", typ: "VO", lvNummer: "CODE-VO", fachDir: "01-legacy-vo",
    terminRel: "01-legacy-vo/term", subjectDir: undefined, subjectFile: undefined,
  };

  it("loads one shared UE/VO note from the stable subject directory regardless of event order", () => {
    const before = JSON.stringify([event, lecture]);

    expect(subjectKnowledgePaths([event, lecture], "Sem01")).toEqual([{ key: "coding", path: notePath }]);
    expect(subjectKnowledgePaths([lecture, event], "Sem01")).toEqual([{ key: "coding", path: notePath }]);
    expect(JSON.stringify([event, lecture])).toBe(before);
  });

  it("keeps the persisted subject filename when the display name changes", () => {
    expect(subjectKnowledgePaths([{ ...event, fach: "New course title", subjectFile: "Original course.md" }], "Sem01"))
      .toEqual([{ key: "coding", path: "Sem01/07-coding/Original course - Sakai.md" }]);
  });

  it("falls back to the existing directory and a sanitized filename before path migration", () => {
    expect(subjectKnowledgePaths([{ ...lecture, fach: "Coding / Basics" }], "Sem01"))
      .toEqual([{ key: "coding", path: "Sem01/01-legacy-vo/Coding Basics - Sakai.md" }]);
  });

  it.each(["../Sem01", "Sem01/nested", "/Sem01", "Sem01%2fother", "Sem01 "])("rejects unsafe semesters: %s", (semester) => {
    expect(() => subjectKnowledgePaths([event], semester)).toThrow();
  });

  it.each([{ subjectDir: "../outside" }, { subjectFile: "../outside.md" }])("rejects unsafe persisted subject paths: %j", (fields) => {
    expect(() => subjectKnowledgePaths([{ ...event, ...fields }], "Sem01")).toThrow();
  });
});

describe("upcomingKnowledge", () => {
  const notice: KnowledgeNotice = { id: "first", title: "First", at: confirmed.zeitpunkt, kind: "frist", sourceUrl: source };

  it("includes now and excludes past notices and the midnight fourteen days ahead", () => {
    const now = new Date(2026, 8, 22, 10).getTime();
    const until = new Date(2026, 9, 6).getTime();
    const note = withNotices([
      { ...notice, id: "end", at: new Date(until).toISOString() },
      { ...notice, id: "last", at: new Date(until - 1000).toISOString() },
      { ...notice, id: "past", at: new Date(now - 1000).toISOString() },
      { ...notice, id: "now", at: new Date(now).toISOString() },
      { ...notice, id: "later", at: new Date(until + 1000).toISOString() },
    ]);

    expect(upcomingKnowledge([note], now).map(({ id }) => id)).toEqual(["now", "last"]);
  });

  it("deduplicates the same source, instant, and kind across notes and UTC offsets", () => {
    const first = withNotices([notice]);
    const second = withNotices([
      { ...notice, id: "copy", at: "2026-09-23T08:00:00Z" },
      { ...notice, id: "other-kind", kind: "termin" },
      { ...notice, id: "other-source", sourceUrl: "https://example.test/sakai/other" },
    ], "Studium/General.md");

    expect(upcomingKnowledge([first, second], Date.parse("2026-09-22T08:00:00Z")).map(({ id }) => id))
      .toEqual(["first", "other-kind", "other-source"]);
  });

  it("sorts by actual instant then title, retaining the original owning note without mutation", () => {
    const note = withNotices([
      { ...notice, id: "late", title: "Late", at: "2026-09-23T10:00:00Z" },
      { ...notice, id: "beta", title: "Beta", sourceUrl: "https://example.test/beta" },
      { ...notice, id: "alpha", title: "Alpha", sourceUrl: "https://example.test/alpha" },
    ]);
    const before = JSON.stringify(note);
    const result = upcomingKnowledge([note], Date.parse("2026-09-22T08:00:00Z"));

    expect(result.map(({ id }) => id)).toEqual(["alpha", "beta", "late"]);
    expect(result[0].note).toBe(note);
    expect(JSON.stringify(note)).toBe(before);
  });

  it("keeps exam dates out of the generic fourteen-day highlights", () => {
    const note = withNotices([
      { ...notice, id: "exam", category: "pruefung" },
      { ...notice, id: "generic" },
    ]);

    expect(upcomingKnowledge([note], Date.parse("2026-09-22T08:00:00Z")).map(({ id }) => id)).toEqual(["generic"]);
  });

  it("returns no highlights for notes that contain only prose dates", () => {
    const note = parseKnowledgeNote("# Exam\nExam on 2026-09-23 at 10:00.\n", notePath)!;

    expect(upcomingKnowledge([note], Date.parse("2026-09-22T08:00:00Z"))).toEqual([]);
  });
});


describe("upcomingExams", () => {
  const exam: KnowledgeNotice = {
    id: "first-exam", title: "First exam", at: "2026-11-19", kind: "frist", sourceUrl: source, category: "pruefung",
  };

  it("shows all upcoming exams in the selected semester beyond fourteen days and retains group information", () => {
    const current: KnowledgeNote = { ...withNotices([exam]), examSemester: "Sem01", group: "IM" };
    const other: KnowledgeNote = { ...withNotices([{ ...exam, id: "other-semester" }]), examSemester: "Sem02" };
    const missing = withNotices([{ ...exam, id: "missing-semester" }]);
    const ordinary: KnowledgeNote = { ...withNotices([{ ...exam, id: "ordinary", category: undefined }]), examSemester: "Sem01" };

    const result = upcomingExams([other, missing, ordinary, current], new Date(2026, 8, 30, 10).getTime(), "Sem01");

    expect(result.map(({ id }) => id)).toEqual(["first-exam"]);
    expect(result[0].note).toBe(current);
    expect(result[0].note.group).toBe("IM");
  });

  it("keeps date-only exams for their whole local day while excluding past exact times", () => {
    const now = new Date(2026, 10, 19, 23, 59, 59).getTime();
    const note: KnowledgeNote = { ...withNotices([
      { ...exam, id: "yesterday", at: "2026-11-18" },
      { ...exam, id: "today", at: "2026-11-19" },
      { ...exam, id: "past-time", at: new Date(now - 1000).toISOString() },
      { ...exam, id: "exact-now", at: new Date(now).toISOString() },
    ]), examSemester: "Sem01" };

    expect(upcomingExams([note], now, "Sem01").map(({ id }) => id)).toEqual(["today", "exact-now"]);
    expect(upcomingExams([note], new Date(2026, 10, 20).getTime(), "Sem01")).toEqual([]);
  });

  it("retains a running exam window through its final day", () => {
    const note: KnowledgeNote = { ...withNotices([
      { ...exam, id: "window", at: "2026-11-16", endDate: "2026-11-20" },
    ]), examSemester: "Sem01" };

    expect(upcomingExams([note], new Date(2026, 10, 19, 15).getTime(), "Sem01").map(({ id }) => id)).toEqual(["window"]);
    expect(upcomingExams([note], new Date(2026, 10, 20, 23, 59, 59).getTime(), "Sem01").map(({ id }) => id)).toEqual(["window"]);
    expect(upcomingExams([note], new Date(2026, 10, 21).getTime(), "Sem01")).toEqual([]);
  });

  it("sorts by calendar date then time with date-only exams first without mutating the notes", () => {
    const note: KnowledgeNote = { ...withNotices([
      { ...exam, id: "next-day", at: "2026-11-20" },
      { ...exam, id: "afternoon", at: new Date(2026, 10, 19, 15).toISOString() },
      { ...exam, id: "morning", at: new Date(2026, 10, 19, 9).toISOString() },
      { ...exam, id: "day-only", at: "2026-11-19" },
      { ...exam, id: "previous-day", at: "2026-11-18" },
    ]), examSemester: "Sem01" };
    const before = JSON.stringify(note);

    const result = upcomingExams([note], new Date(2026, 10, 17).getTime(), "Sem01");

    expect(result.map(({ id }) => id)).toEqual(["previous-day", "day-only", "morning", "afternoon", "next-day"]);
    expect(result[0].note).toBe(note);
    expect(JSON.stringify(note)).toBe(before);
  });

  it("places a date without a time before an exact midnight on the same day", () => {
    const note: KnowledgeNote = { ...withNotices([
      { ...exam, id: "midnight", title: "A timed exam", at: new Date(2026, 10, 19).toISOString() },
      { ...exam, id: "date-only", title: "Z untimed exam", at: "2026-11-19" },
    ]), examSemester: "Sem01" };

    expect(upcomingExams([note], new Date(2026, 10, 18).getTime(), "Sem01").map(({ id }) => id)).toEqual(["date-only", "midnight"]);
  });

  it("does not collapse otherwise identical exam records for different groups", () => {
    const im: KnowledgeNote = { ...withNotices([exam]), examSemester: "Sem01", group: "IM" };
    const it: KnowledgeNote = { ...withNotices([exam], "Studium/IT exams.md"), examSemester: "Sem01", group: "IT" };

    expect(upcomingExams([im, it], new Date(2026, 8, 30).getTime(), "Sem01").map(({ note }) => note.group)).toEqual(["IM", "IT"]);
  });

  it("deduplicates the same exam instant across UTC offsets while retaining distinct IDs", () => {
    const first: KnowledgeNote = { ...withNotices([
      { ...exam, at: "2026-11-19T13:15:00+01:00" },
    ]), examSemester: "Sem01", group: "IM" };
    const second: KnowledgeNote = { ...withNotices([
      { ...exam, at: "2026-11-19T12:15:00Z" },
      { ...exam, id: "second-exam", at: "2026-11-19T12:15:00Z" },
    ], "Studium/Exams.md"), examSemester: "Sem01", group: "IM" };

    expect(upcomingExams([first, second], new Date(2026, 8, 30).getTime(), "Sem01").map(({ id }) => id))
      .toEqual(["first-exam", "second-exam"]);
  });

  it("deduplicates copied exam records while preserving separate exams at the same time", () => {
    const first: KnowledgeNote = { ...withNotices([exam]), examSemester: "Sem01" };
    const second: KnowledgeNote = { ...withNotices([
      exam,
      { ...exam, id: "second-exam" },
      { ...exam, sourceUrl: "https://example.test/other-source" },
      { ...exam, endDate: "2026-11-20" },
    ], "Studium/Exams.md"), examSemester: "Sem01" };

    const result = upcomingExams([first, second], new Date(2026, 8, 30).getTime(), "Sem01");

    expect(result).toHaveLength(4);
    expect(result.filter(({ id }) => id === "second-exam")).toHaveLength(1);
    expect(result.filter(({ note }) => note === first)).toHaveLength(1);
  });
});
