import { beforeEach, describe, expect, it } from "vitest";
import { buildFachMoc, MOC_END, MOC_START, parseNote, readStatus } from "../src/lib/notes.ts";
import { planVaultMigration } from "../src/lib/vaultMigration.ts";
import type { StudyEvent } from "../src/lib/types.ts";

const semester = "Sem01-MCiT26-IM";
const indexPath = `${semester}/.mci-manager/event-paths.json`;
const firstRel = "03-databases_alpha/2026-10-05_databases-ilv";
const secondRel = "04-databases_beta/2026-10-06_databases-ilv";
const futureRel = "04-databases_beta/2026-10-07_databases-ilv";
const oldNote = `${semester}/${firstRel}/notes.md`;
const firstName = "2026-10-05 0900 Databases.md";
const newNote = `${semester}/${firstRel}/${firstName}`;
const subjectPath = `${semester}/03-databases_alpha/Databases.md`;
const staleMoc = `${semester}/01-databases_old/_Fach.md`;
const firstMoc = `${semester}/03-databases_alpha/_Fach.md`;
const secondMoc = `${semester}/04-databases_beta/_Fach.md`;

const personal = '\uFEFF---\r\nuid: "one"\r\nfach: Databases\r\nlv: LV123\r\ntermin: 2026-10-05T07:00:00Z\r\nvorbereitet: true # Keep this\r\nnachbereitet: false\r\ncustom: { nested: [1, "two"], count: 12345678901234567890 }\r\ntags: [mci/sem01, fach/databases-ilv]\r\n---\r\n## Vorbereitung\r\n- [x] Read\r\n\r\n## Mitschrift\r\nKeep  these spaces.\r\n\r\n## Nachbereitung\r\n- [ ] Review\r\n';

function legacyMoc(name = "Databases", lv = "LV123", teacher = "Dr. Alpha"): string {
  return `---\ntags: [mci/sem01, fach/databases-ilv]\nfach: ${name}\n---\n# ${name} (ILV)\n\n> ${teacher} · LV ${lv}\n\n## Termine\n\n${MOC_START}\n- [[${firstRel}/notes|Old appointment]]\n${MOC_END}\n\n\`\`\`dataview\nTABLE termin AS Termin, vorbereitet AS VB, nachbereitet AS NB\nFROM "${semester}/03-databases_alpha"\nWHERE file.name = "notes"\nSORT termin ASC\n\`\`\`\n\n## Offene Fragen\n\n## Prüfungsthemen\n`;
}

let files: Map<string, string>;
let events: StudyEvent[];

beforeEach(() => {
  events = [
    { uid: "one", summary: "Databases (ILV)", fach: "Databases", typ: "ILV", dozent: "Dr. Alpha", lvNummer: "LV123", fachKey: "lv-databases", fachDir: "new-dir", terminRel: "new-dir/new-one", start: "2026-10-05T07:00:00Z", end: "2026-10-05T09:00:00Z" },
    { uid: "two", summary: "Databases (ILV)", fach: "Databases", typ: "ILV", dozent: "Dr. Beta", lvNummer: "LV123", fachKey: "lv-databases", fachDir: "new-dir", terminRel: "new-dir/new-two", start: "2026-10-06T07:00:00Z", end: "2026-10-06T09:00:00Z" },
    { uid: "future", summary: "Databases (ILV)", fach: "Databases", typ: "ILV", dozent: "Dr. Beta", lvNummer: "LV123", fachKey: "lv-databases", fachDir: "new-dir", terminRel: "new-dir/new-three", start: "2026-10-07T07:00:00Z", end: "2026-10-07T09:00:00Z" },
  ];
  files = new Map([
    [indexPath, JSON.stringify({ version: 1, paths: { one: firstRel, two: secondRel, future: futureRel }, subjects: { "databases-ilv": "03-databases_alpha" }, reserved: [firstRel, secondRel, futureRel] })],
    [oldNote, personal],
    [`${semester}/${secondRel}/notes.md`, personal.replace('uid: "one"', 'uid: "two"')],
    [staleMoc, legacyMoc("Geleitetes Selbststudium Databases", "LV123\\nUnterrichtseinheiten: 2", "Dr. Old")],
    [firstMoc, legacyMoc()],
    [secondMoc, legacyMoc("Databases", "LV123", "Dr. Beta")],
  ]);
});

describe("planVaultMigration", () => {
  it("renames only existing notes while preserving every indexed UID folder and personal byte", () => {
    const input = new Map(files);
    const plan = planVaultMigration({ files, events, semester });

    expect(plan.index.paths).toEqual({ one: firstRel, two: secondRel, future: futureRel });
    expect(plan.events[0]).toMatchObject({ terminRel: firstRel, noteFile: firstName, subjectDir: "03-databases_alpha", subjectFile: "Databases.md" });
    expect(plan.files.get(newNote)).toBe(personal);
    expect(plan.files.has(oldNote)).toBe(false);
    expect(plan.files.has(`${semester}/${futureRel}/${plan.events[2].noteFile}`)).toBe(false);
    expect(plan.summary).toMatchObject({ events: 3, subjects: 1, renames: 2, archives: 3, existingUidPaths: 3, preservedUidPaths: 3, existingNotes: 2, unchangedNoteBytes: 2, unchangedNoteBodies: 2 });
    expect(files).toEqual(input);
  });

  it("merges stale and multi-teacher MOCs by LV and generates fully qualified future links", () => {
    const plan = planVaultMigration({ files, events, semester });
    const moc = plan.files.get(subjectPath)!;

    expect(plan.changes.filter((change) => change.kind === "archive")).toEqual(expect.arrayContaining([
      { kind: "archive", path: staleMoc, before: files.get(staleMoc), canonical: subjectPath },
    ]));
    expect(moc).toContain("Dr. Alpha, Dr. Beta");
    expect(moc).toContain(`[[${semester}/${futureRel}/2026-10-07 0900 Databases|`);
    expect(moc).toContain(`FROM "${semester}"\nWHERE uid AND lv = "LV123"`);
    expect(parseNote(moc).data.tags).toContain("mci/sem01");
    expect(plan.summary.preservedOriginals).toBe(0);
  });

  it("keeps status, tasks, comments and custom YAML when normalizing only a malformed LV scalar", () => {
    const source = personal.replace("lv: LV123", 'lv: "LV123\\\\nUnterrichtseinheiten: 2" # historical');
    files.set(oldNote, source);
    const plan = planVaultMigration({ files, events, semester });
    const migrated = plan.files.get(newNote)!;

    expect(migrated).toBe(source.replace('"LV123\\\\nUnterrichtseinheiten: 2"', '"LV123"'));
    expect(parseNote(migrated).body).toBe(parseNote(source).body);
    expect(parseNote(migrated).data.custom).toEqual(parseNote(source).data.custom);
    expect(readStatus(parseNote(migrated).data, parseNote(migrated).body)).toEqual({ vorbereitet: true, nachbereitet: false });
    expect(plan.summary.normalizedLvFields).toBe(1);
  });

  it("preserves the full attributed original when custom MOC YAML, sections or generated text are present", () => {
    const customized = legacyMoc().replace("fach: Databases", "fach: Databases\ncustom: { plugin: true }") + "\n## My research\nKeep this exactly.\n````text\nprivate example\n````\n";
    files.set(firstMoc, customized);
    const plan = planVaultMigration({ files, events, semester });

    expect(plan.files.get(subjectPath)).toContain(`### Original: ${firstMoc}\n\n\`\`\`\`\`text\n${customized}\`\`\`\`\``);
    expect(plan.summary.preservedOriginals).toBe(1);
    expect(plan.changes.find((change) => change.kind === "archive" && change.path === firstMoc)?.before).toBe(customized);
  });

  it.each(["[[Other/_Semester|Semester-Übersicht]]", `[[${semester}/_Semester|My semester]]`])("preserves a custom subject breadcrumb: %s", (breadcrumb) => {
    const customized = legacyMoc().replace("# Databases (ILV)\n\n", `# Databases (ILV)\n\n${breadcrumb}\n\n`);
    files.set(firstMoc, customized);

    const plan = planVaultMigration({ files, events, semester });

    expect(plan.summary.preservedOriginals).toBe(1);
    expect(plan.files.get(subjectPath)).toContain(customized);
  });

  it("preserves personal README and semester sections while updating generated lists and known Dataview scopes", () => {
    const query = `\`\`\`dataview\nTABLE termin\nFROM "${semester}/04-databases_beta"\nWHERE file.name = "notes" AND vorbereitet = false\n\`\`\``;
    files.set("README.md", `# My dashboard\n\nPersonal  paragraph.\n${query}\n\nTail.\n`);
    files.set(`${semester}/_Semester.md`, `---\ncustom: true\n---\n# My semester\n${MOC_START}\nOld generated rows\n${MOC_END}\n\n## Goals\n- [x] Keep\n`);
    const plan = planVaultMigration({ files, events, semester });

    expect(plan.files.get("README.md")).toBe(files.get("README.md")!.replace(`${semester}/04-databases_beta`, semester).replace('file.name = "notes"', 'uid AND lv = "LV123"'));
    expect(plan.files.get(`${semester}/_Semester.md`)).toContain("---\ncustom: true\n---\n# My semester\n");
    expect(plan.files.get(`${semester}/_Semester.md`)).toContain("\n\n## Goals\n- [x] Keep\n");
    expect(plan.files.get(`${semester}/_Semester.md`)).toContain(`[[${semester}/03-databases_alpha/Databases|`);
  });

  it("rewrites full, semester-relative and folder-relative wiki links with fragments, aliases and embeds", () => {
    files.set("References.md", `![[${stemPath(oldNote)}#Mitschrift|My alias]]\n[[03-databases_alpha/_Fach#Offene Fragen]]\n[[Other/Unrelated|Keep]]`);
    files.set(`${semester}/03-databases_alpha/Helper.md`, `[[./_Fach#^block|LV]]\n[[${firstRel}/notes.md]]`);
    const plan = planVaultMigration({ files, events, semester });

    expect(plan.files.get("References.md")).toBe(`![[${stemPath(newNote)}#Mitschrift|My alias]]\n[[${stemPath(subjectPath)}#Offene Fragen]]\n[[Other/Unrelated|Keep]]`);
    expect(plan.files.get(`${semester}/03-databases_alpha/Helper.md`)).toBe(`[[${stemPath(subjectPath)}#^block|LV]]\n[[${newNote}]]`);
  });

  it("rewrites Markdown destinations, reference definitions and relative links without touching labels or titles", () => {
    files.set("References.md", `[MOC](<${firstMoc}#Offene-Fragen> "My title")\n[appointment][ref]\n[ref]: ${oldNote}#Mitschrift "Retain"\n[external](https://example.org/notes.md)`);
    files.set(`${semester}/${firstRel}/scratch.md`, "[self](notes.md#Mitschrift)\n[LV](../_Fach.md)");
    const plan = planVaultMigration({ files, events, semester });

    expect(plan.files.get("References.md")).toContain(`[MOC](<${subjectPath}#Offene-Fragen> "My title")`);
    expect(plan.files.get("References.md")).toContain(`[ref]: ${newNote.replaceAll(" ", "%20")}#Mitschrift "Retain"`);
    expect(plan.files.get("References.md")).toContain("[external](https://example.org/notes.md)");
    expect(plan.files.get(`${semester}/${firstRel}/scratch.md`)).toBe("[self](2026-10-05%200900%20Databases.md#Mitschrift)\n[LV](../Databases.md)");
  });

  it("leaves code examples, escaped links, unrelated links and hidden archives byte-identical", () => {
    const source = `\`[[${firstMoc}]]\`\n\`\`\`md\n[[${firstMoc}]]\n\`\`\`\n\\[[${firstMoc}]]\n[[Untouched]]`;
    const hidden = `${semester}/.mci-manager/history/old.md`;
    files.set("Examples.md", source);
    files.set(hidden, `[[${firstMoc}]]`);
    files.set(".obsidian/custom.md", `[[${firstMoc}]]`);
    const plan = planVaultMigration({ files, events, semester });

    expect(plan.files.get("Examples.md")).toBe(source);
    expect(plan.files.get(hidden)).toBe(files.get(hidden));
    expect(plan.files.get(".obsidian/custom.md")).toBe(files.get(".obsidian/custom.md"));
  });

  it("is idempotent including preserved originals and the index", () => {
    files.set(firstMoc, legacyMoc() + "\nPersonal tail\n");
    const first = planVaultMigration({ files, events, semester });
    const second = planVaultMigration({ files: first.files, events, semester });

    expect(second.changes).toEqual([]);
    expect(second.files).toEqual(first.files);
    expect(second.rawIndex).toBe(first.rawIndex);
  });

  it("retains allocated filenames after calendar display names change", () => {
    const first = planVaultMigration({ files, events, semester });
    const renamedEvents = events.map((event) => ({ ...event, fach: "Database Systems" }));
    const second = planVaultMigration({ files: first.files, events: renamedEvents, semester });

    expect(second.events[0]).toMatchObject({ noteFile: firstName, subjectFile: "Databases.md", terminRel: firstRel });
    expect(second.changes.map((change) => ({ kind: change.kind, path: change.path }))).toEqual([{ kind: "write", path: `${semester}/_Semester.md` }]);
    expect(second.files.get(newNote)).toBe(personal);
    expect(planVaultMigration({ files: second.files, events: renamedEvents, semester }).changes).toEqual([]);
  });

  it("keeps same-named different-LV subjects distinct even when they share a physical directory", () => {
    files = new Map([[indexPath, JSON.stringify({ version: 1, paths: { one: firstRel, two: secondRel }, subjects: { "lv-databases": "shared", "lv-other": "shared" }, reserved: [] })]]);
    events = [events[0], { ...events[1], fachKey: "lv-other", lvNummer: "LV456" }];
    const first = planVaultMigration({ files, events, semester });
    const second = planVaultMigration({ files: first.files, events, semester });

    expect(first.events.map((event) => event.subjectFile)).toEqual(["Databases.md", "Databases (2).md"]);
    expect(first.files.get(`${semester}/shared/Databases (2).md`)).toContain('lv = "LV456"');
    expect(second.changes).toEqual([]);
  });

  it.each([false, true])("consolidates named VO and UE subjects without losing historical notes (VO absent: %s)", (historical) => {
    const uePath = `${semester}/03-databases_alpha/Coding UE.md`;
    const voPath = `${semester}/04-databases_beta/Coding VO.md`;
    const mergedPath = `${semester}/03-databases_alpha/Coding.md`;
    events = events.slice(0, 2).map((event, i) => ({ ...event, fach: "Coding", fachKey: "coding", typ: i ? "VO" : "UE",
      lvNummer: `MCI-B-1-COD-COD-${i ? "VO" : "UE"}` }));
    const moc = (i: number) => buildFachMoc({ fach: `Coding ${events[i].typ}`, typ: events[i].typ,
      dozent: events[i].dozent, lvBeispiel: events[i].lvNummer, fachDir: "unused", semesterPath: semester,
      fachTag: `fach/old-${events[i].typ}`, semesterTag: "mci/sem01", termine: [] });
    const userText = "\n## Personal questions\nKeep  this text.\n";
    files = new Map([
      [indexPath, JSON.stringify({ version: 2, paths: { one: firstRel, two: secondRel },
        subjects: { "old-ue": "03-databases_alpha", "old-vo": "04-databases_beta" }, reserved: [firstRel, secondRel],
        files: { [firstRel]: firstName }, subjectFiles: { "old-ue": "Coding UE.md", "old-vo": "Coding VO.md" } })],
      [uePath, moc(0)], [voPath, moc(1) + userText],
      [newNote, personal.replace("LV123", events[0].lvNummer)],
      ["References.md", `[[Coding UE#Termine|Practice]]\n[Lecture](<${voPath}>)`],
    ]);
    const calendar = historical ? events.slice(0, 1) : events;
    const plan = planVaultMigration({ files, events: calendar, semester });

    expect(plan.summary).toMatchObject({ subjects: 1, events: calendar.length, archives: 2, renames: 0,
      existingUidPaths: 2, preservedUidPaths: 2, existingNotes: 1, unchangedNoteBytes: 1, preservedOriginals: 1 });
    expect(plan.files.get(newNote)).toBe(files.get(newNote));
    expect(plan.events.map((event) => event.typ)).toEqual(calendar.map((event) => event.typ));
    expect(plan.events.map((event) => event.subjectFile)).toEqual(calendar.map(() => "Coding.md"));
    expect(plan.index.subjectFiles).toEqual({ coding: "Coding.md" });
    const content = plan.files.get(mergedPath)!;
    expect(content).toContain("# Coding\n");
    expect(content).toContain("UE / VO");
    expect(content).toContain(events[0].lvNummer);
    expect(content).toContain(events[1].lvNummer);
    expect(content).toContain('WHERE uid AND contains(["MCI-B-1-COD-COD-UE","MCI-B-1-COD-COD-VO"], lv)');
    expect(content).toContain(`${firstRel}/${firstName.slice(0, -3)}`);
    expect(content).toContain(userText);
    expect(plan.files.get("References.md")).toBe(`[[${stemPath(mergedPath)}#Termine|Practice]]\n[Lecture](<${mergedPath}>)`);
    expect(planVaultMigration({ files: plan.files, events: calendar, semester }).changes).toEqual([]);
  });

  it("transfers an unchanged named subject to its new identity without duplicating its MOC", () => {
    const first = planVaultMigration({ files, events, semester });
    const rekeyed = events.map((event) => ({ ...event, fachKey: "new-course-identity" }));
    const next = planVaultMigration({ files: first.files, events: rekeyed, semester });

    expect(next.index.subjectFiles).toEqual({ "new-course-identity": "Databases.md" });
    expect(next.files.get(subjectPath)).toBe(first.files.get(subjectPath));
    expect(next.summary).toMatchObject({ archives: 0, renames: 0, writes: 1 });
    expect(planVaultMigration({ files: next.files, events: rekeyed, semester }).changes).toEqual([]);
  });

  it("includes a historical teaching type known only from an existing appointment note", () => {
    events = [{ ...events[0], fach: "Coding", fachKey: "coding", typ: "UE", lvNummer: "MCI-B-1-COD-COD-UE" }];
    const historicalNote = personal.replace('uid: "one"', 'uid: "two"').replace("LV123", "MCI-B-1-COD-COD-VO");
    files = new Map([
      [indexPath, JSON.stringify({ version: 2, paths: { one: firstRel, two: secondRel }, subjects: {}, reserved: [firstRel, secondRel],
        files: { [firstRel]: firstName, [secondRel]: "Lecture.md" }, subjectFiles: {} })],
      [newNote, personal.replace("LV123", events[0].lvNummer)],
      [`${semester}/${secondRel}/Lecture.md`, historicalNote],
    ]);

    const plan = planVaultMigration({ files, events, semester });
    const content = plan.files.get(`${semester}/03-databases_alpha/Coding.md`)!;
    expect(content).toContain('WHERE uid AND contains(["MCI-B-1-COD-COD-UE","MCI-B-1-COD-COD-VO"], lv)');
    expect(content).toContain("> UE / VO");
    expect(plan.files.get(`${semester}/${secondRel}/Lecture.md`)).toBe(historicalNote);
    expect(plan.summary.unchangedNoteBytes).toBe(2);
    expect(planVaultMigration({ files: plan.files, events, semester }).changes).toEqual([]);
  });

  it("rejects different course codes accidentally grouped under one key", () => {
    events[1] = { ...events[1], lvNummer: "DIFFERENT-COURSE-UE" };
    expect(() => planVaultMigration({ files, events, semester })).toThrow("Widersprüchliche Fachidentität");
  });

  it("rejects calendars still split into multiple keys for the same course", () => {
    events[1] = { ...events[1], fachKey: "legacy-split", typ: "UE" };
    expect(() => planVaultMigration({ files, events, semester })).toThrow("nach Fach gruppiert");
  });

  it("ignores malformed unmanaged Markdown and scratch notes with an empty UID", () => {
    files.set(`${semester}/${firstRel}/scratch.md`, "---\nuid: ''\n---\nScratch");
    files.set(`${semester}/${firstRel}/broken.md`, "---\ncustom: [broken\n---\nKeep");
    const plan = planVaultMigration({ files, events, semester });

    expect(plan.summary.existingNotes).toBe(2);
    expect(plan.files.get(`${semester}/${firstRel}/broken.md`)).toBe(files.get(`${semester}/${firstRel}/broken.md`));
  });

  it.each(["_Fach", "notes"])("blocks ambiguous basename references to %s", (name) => {
    files.set("Ambiguous.md", `[[${name}#Heading|Alias]]`);

    expect(() => planVaultMigration({ files, events, semester })).toThrow("Mehrdeutiger lokaler Link");
  });

  it("blocks ambiguous historical subjects with no LV rather than guessing by name", () => {
    files.set(firstMoc, legacyMoc().replace(" · LV LV123", ""));
    events.push({ ...events[0], uid: "other", fachKey: "lv-other", lvNummer: "LV456" });

    expect(() => planVaultMigration({ files, events, semester })).toThrow("mehrdeutig");
  });

  it("blocks unknown historical MOCs instead of discarding their text", () => {
    files.set(firstMoc, legacyMoc("Unknown course", "OTHER-LV"));

    expect(() => planVaultMigration({ files, events, semester })).toThrow("unbekannt");
  });

  it.each([newNote, newNote.toUpperCase(), subjectPath])("refuses a destination collision: %s", (target) => {
    files.set(target, "Private unrelated file");

    expect(() => planVaultMigration({ files, events, semester })).toThrow(/existiert|Zieldatei|kollidiert/);
    expect(files.get(target)).toBe("Private unrelated file");
  });

  it.each(["{broken", '{"version":2}', '{"version":1,"paths":{"one":"../outside"},"subjects":{},"reserved":[]}'])("rejects an invalid index without modifying inputs", (raw) => {
    files.set(indexPath, raw);

    expect(() => planVaultMigration({ files, events, semester })).toThrow();
    expect(files.get(indexPath)).toBe(raw);
  });

  it("rejects conflicting UIDs before producing a plan", () => {
    files.set(`${semester}/${secondRel}/notes.md`, personal);

    expect(() => planVaultMigration({ files, events, semester })).toThrow("UID");
  });

  it("preserves historical note UIDs absent from the current calendar", () => {
    events = events.filter((event) => event.uid !== "two");
    const plan = planVaultMigration({ files, events, semester });

    expect(plan.index.paths.two).toBe(secondRel);
    expect(plan.files.get(`${semester}/${secondRel}/2026-10-05 0900 Databases.md`)).toBe(personal.replace('uid: "one"', 'uid: "two"'));
  });

  it("refuses empty calendars and unsafe semesters", () => {
    expect(() => planVaultMigration({ files, events: [], semester })).toThrow("leerer Kalender");
    expect(() => planVaultMigration({ files, events, semester: "../outside" })).toThrow();
  });
});

function stemPath(path: string): string {
  return path.slice(0, -3);
}
