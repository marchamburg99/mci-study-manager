import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_KNOWLEDGE_BYTES, MAX_KNOWLEDGE_NOTES } from "../src/lib/knowledge";
import { loadKnowledge } from "../src/lib/knowledgeStorage";
import type { DocEntry } from "../src/lib/storage";
import type { AppConfig, StudyEvent } from "../src/lib/types";

const cfg: AppConfig = {
  basisPfad: "/synthetic/vault", semester: "Sem01", icalUrl: "https://example.test/calendar",
  refreshHours: 12, lastRefresh: null,
};
const event: StudyEvent = {
  uid: "example-ue", summary: "Coding UE", fach: "Coding", typ: "UE", dozent: "Example", lvNummer: "CODE-UE",
  fachKey: "coding", fachDir: "02-legacy-ue", terminRel: "02-legacy-ue/term",
  subjectDir: "07-coding", subjectFile: "Coding.md",
  start: "2026-09-22T08:00:00.000Z", end: "2026-09-22T09:00:00.000Z",
};
const subjectPath = "/synthetic/vault/Sem01/07-coding/Coding - Sakai.md";
const generalPath = "/synthetic/vault/Studium/General.md";
const indexPath = "/synthetic/vault/Sem01/.mci-manager/event-paths.json";
const subjectRaw = "---\nfach: Coding\nsource_url: https://example.test/sakai/course\n---\n# Coding\n";
let files: Map<string, string>;
let entries: DocEntry[];
let directories: Map<string, DocEntry[]>;
let errors: Map<string, Error>;
let calls: Array<{ command: string; args: Record<string, unknown> }>;
let delayedReads: boolean;
let activeReads: number;
let peakReads: number;

beforeEach(() => {
  files = new Map();
  entries = [];
  directories = new Map();
  errors = new Map();
  calls = [];
  delayedReads = false;
  activeReads = 0;
  peakReads = 0;
  vi.stubGlobal("window", {});
  mockIPC((command, payload) => {
    const args = (payload ?? {}) as Record<string, unknown>;
    calls.push({ command, args });
    const failure = errors.get(`${command}:${args.path ?? args.dir}`);
    if (failure) throw failure;
    switch (command) {
      case "plugin:path|join": return (args.paths as string[]).join("/");
      case "list_docs": return String(args.dir).endsWith("/Studium") ? entries : directories.get(String(args.dir)) ?? [];
      case "read_text_file": {
        const result = files.get(args.path as string) ?? null;
        if (!delayedReads) return result;
        activeReads++;
        peakReads = Math.max(peakReads, activeReads);
        return new Promise((resolve) => setTimeout(() => { activeReads--; resolve(result); }, 1));
      }
      default: throw new Error(`Unexpected IPC command: ${command}`);
    }
  });
});

afterEach(() => {
  clearMocks();
  vi.unstubAllGlobals();
  expect(calls.filter(({ command }) => !["plugin:path|join", "list_docs", "read_text_file"].includes(command))).toEqual([]);
});

describe("loadKnowledge", () => {
  it("assigns an existing Studium summary using its exact normalized course name", async () => {
    const communication = { ...event, fach: "Communication Training", fachKey: "communication", lvNummer: "MCI-B-1-COM-COT-ILV" };
    entries = [{ name: "Zusammenfassung Session 1.md", path: "ignored", size: 100 }];
    files.set("/synthetic/vault/Studium/Zusammenfassung Session 1.md", '---\nfach: "  communication   TRAINING  "\ntags: [fach/old-identifier]\n---\n# Session 1\n');

    const catalog = await loadKnowledge(cfg, [communication]);

    expect(catalog).toMatchObject({ warnings: [], notes: [{ title: "Session 1", subjectKey: "communication" }] });
  });

  it("loads presentation and assignment sibling notes from a known class directory", async () => {
    const folder = "/synthetic/vault/Sem01/02-legacy-ue/term";
    directories.set(folder, [
      { name: "Lernpräsentation.md", path: "ignored", size: 100 },
      { name: "Assignment 1.md", path: "ignored", size: 100 },
      { name: "notes.md", path: "ignored", size: 100 },
      { name: "Other appointment.md", path: "ignored", size: 100 },
    ]);
    files.set(`${folder}/Lernpräsentation.md`, "# Lernpräsentation Session 1\n");
    files.set(`${folder}/Assignment 1.md`, "# Assignment 1\n");
    files.set(`${folder}/notes.md`, "---\nuid: example-ue\n---\n# Main note\n");
    files.set(`${folder}/Other appointment.md`, "---\nuid: another-event\n---\n# Other appointment\n");

    const catalog = await loadKnowledge(cfg, [event]);

    expect(catalog).toMatchObject({ warnings: [], notes: [
      { title: "Assignment 1", subjectKey: "coding", path: "Sem01/02-legacy-ue/term/Assignment 1.md" },
      { title: "Lernpräsentation Session 1", subjectKey: "coding", path: "Sem01/02-legacy-ue/term/Lernpräsentation.md" },
    ] });
    expect(catalog.notes).toHaveLength(2);
    expect(calls.some(({ command, args }) => command === "read_text_file" && args.path === `${folder}/notes.md`)).toBe(false);
  });

  it("keeps indexed class notes after their event leaves the calendar, within known subject folders", async () => {
    const oldPath = "02-legacy-ue/previous-term";
    const folder = `/synthetic/vault/Sem01/${oldPath}`;
    files.set(indexPath, JSON.stringify({ version: 2,
      paths: { previous: oldPath, duplicate: oldPath, foreign: "unknown-subject/term" },
      subjects: { coding: "02-legacy-ue", foreign: "unknown-subject" }, reserved: ["02-legacy-ue/reserved-only"],
      files: { [oldPath]: "Previous class.md" }, subjectFiles: {},
    }));
    directories.set(folder, [
      { name: "Presentation.md", path: "ignored", size: 100 },
      { name: "Previous class.md", path: "ignored", size: 100 },
      { name: "Another unit.md", path: "ignored", size: 100 },
    ]);
    files.set(`${folder}/Presentation.md`, "# Previous presentation\n");
    files.set(`${folder}/Previous class.md`, "# Main class note\n");
    files.set(`${folder}/Another unit.md`, "---\nuid: old-unit\n---\n# Unit\n");

    const catalog = await loadKnowledge(cfg, [event]);

    expect(catalog).toMatchObject({ warnings: [], notes: [{ title: "Previous presentation", subjectKey: "coding" }] });
    expect(catalog.notes).toHaveLength(1);
    expect(calls.filter(({ command, args }) => command === "list_docs" && args.dir === folder)).toHaveLength(1);
    expect(calls.some(({ command, args }) => command === "read_text_file" && args.path === `${folder}/Previous class.md`)).toBe(false);
    expect(calls.filter(({ command }) => command === "list_docs").every(({ args }) => !String(args.dir).includes("unknown-subject") && !String(args.dir).includes("reserved-only"))).toBe(true);
  });

  it("keeps current class notes available when the persisted index is invalid", async () => {
    files.set(indexPath, "{broken");
    files.set(subjectPath, subjectRaw);

    const catalog = await loadKnowledge(cfg, [event]);

    expect(catalog.notes).toMatchObject([{ title: "Coding", subjectKey: "coding" }]);
    expect(catalog.warnings).toEqual([expect.stringContaining("Terminpfad-Index")]);
  });

  it("discovers both shared and legacy UE/VO course directories without duplicating the canonical Sakai note", async () => {
    const lecture = { ...event, uid: "example-vo", typ: "VO" as const, fachDir: "01-legacy-vo", terminRel: "01-legacy-vo/term" };
    directories.set("/synthetic/vault/Sem01/07-coding", [
      { name: "Coding.md", path: "ignored", size: 20 },
      { name: "Coding - Sakai.md", path: "ignored", size: 20 },
      { name: "Topic.md", path: "ignored", size: 20 },
      { name: "Topic.md", path: "ignored", size: 20 },
    ]);
    directories.set("/synthetic/vault/Sem01/02-legacy-ue", [{ name: "UE.md", path: "ignored", size: 20 }]);
    directories.set("/synthetic/vault/Sem01/01-legacy-vo", [{ name: "VO.md", path: "ignored", size: 20 }]);
    files.set(subjectPath, subjectRaw);
    files.set("/synthetic/vault/Sem01/07-coding/Coding.md", "# Generated course index\n");
    files.set("/synthetic/vault/Sem01/07-coding/Topic.md", "# Topic\n");
    files.set("/synthetic/vault/Sem01/02-legacy-ue/UE.md", "# Exercise summary\n");
    files.set("/synthetic/vault/Sem01/01-legacy-vo/VO.md", "# Lecture summary\n");

    const catalog = await loadKnowledge(cfg, [lecture, event]);

    expect(catalog.notes.map(({ title }) => title)).toEqual(["Coding", "Exercise summary", "Lecture summary", "Topic"]);
    expect(catalog.notes.every(({ subjectKey }) => subjectKey === "coding")).toBe(true);
    expect(catalog.warnings).toEqual([]);
    expect(calls.filter(({ command, args }) => command === "read_text_file" && args.path === subjectPath)).toHaveLength(1);
    expect(calls.filter(({ command, args }) => command === "list_docs" && args.dir === "/synthetic/vault/Sem01/07-coding")).toHaveLength(1);
    expect(calls.some(({ command, args }) => command === "read_text_file" && args.path === "/synthetic/vault/Sem01/07-coding/Coding.md")).toBe(false);
  });

  it("excludes the persisted course index filename when the display name changed", async () => {
    const renamed = { ...event, fach: "New Coding", subjectFile: "Original coding.md" };
    directories.set("/synthetic/vault/Sem01/07-coding", [
      { name: "Original coding.md", path: "ignored", size: 20 },
      { name: "New Coding.md", path: "ignored", size: 20 },
    ]);

    expect(await loadKnowledge(cfg, [renamed])).toEqual({ notes: [], warnings: [] });
    expect(calls.filter(({ command }) => command === "read_text_file").map(({ args }) => args.path))
      .toEqual([indexPath, "/synthetic/vault/Sem01/07-coding/Original coding - Sakai.md"]);
  });

  it.each([
    { lv: "  code-ue " },
    { fach: "CODING", lv: "CODE-VO" },
  ])("assigns unambiguous LV metadata across UE and VO: %j", async (metadata) => {
    const lecture = { ...event, uid: "example-vo", typ: "VO" as const, lvNummer: "CODE-VO" };
    entries = [{ name: "General.md", path: "ignored", size: 100 }];
    files.set(generalPath, `---\n${JSON.stringify(metadata)}\n---\n# Summary\n`);

    const catalog = await loadKnowledge(cfg, [event, lecture]);

    expect(catalog).toMatchObject({ warnings: [], notes: [{ subjectKey: "coding" }] });
  });

  it.each([
    { fach: "Coding", lv: "NETWORKS" },
    { fach: "Coding", lv: "unknown" },
    { fach: "unknown", lv: "CODE-UE" },
  ])("keeps conflicting course and LV hints unassigned: %j", async (metadata) => {
    const other = { ...event, uid: "other", fach: "Networks", fachKey: "networks", fachDir: "networks", subjectDir: "networks", subjectFile: "Networks.md", terminRel: "networks/term", lvNummer: "NETWORKS" };
    entries = [{ name: "General.md", path: "ignored", size: 100 }];
    files.set(generalPath, `---\n${JSON.stringify(metadata)}\n---\n# Summary\n`);

    const catalog = await loadKnowledge(cfg, [event, other]);

    expect(catalog.notes).toMatchObject([{ subjectKey: null }]);
    expect(catalog.warnings).toEqual([expect.stringContaining("keine eindeutige Fachzuordnung")]);
  });

  it("keeps duplicate course names unassigned instead of selecting the first match", async () => {
    const other = { ...event, uid: "other", fachKey: "coding-other", fachDir: "other", subjectDir: "other", terminRel: "other/term", lvNummer: "OTHER" };
    entries = [{ name: "General.md", path: "ignored", size: 100 }];
    files.set(generalPath, "---\nfach: Coding\n---\n# Summary\n");

    const catalog = await loadKnowledge(cfg, [event, other]);

    expect(catalog.notes).toMatchObject([{ subjectKey: null }]);
    expect(catalog.warnings).toEqual([expect.stringContaining("keine eindeutige Fachzuordnung")]);
  });

  it("does not infer a course from similar titles or legacy tags", async () => {
    entries = [{ name: "General.md", path: "ignored", size: 100 }];
    files.set(generalPath, "---\nfach: Coding skills\ntags: [fach/coding]\n---\n# Coding\n");

    expect(await loadKnowledge(cfg, [event])).toMatchObject({ warnings: [], notes: [{ subjectKey: null }] });
  });

  it.each(["semester", "pruefungssemester"])("does not assign another explicitly named semester through %s", async (field) => {
    entries = [{ name: "General.md", path: "ignored", size: 100 }];
    const raw = `---\nfach: Coding\n${field}: Sem00\n---\n# Old summary\n`;
    files.set(generalPath, raw);
    files.set(subjectPath, raw);

    const catalog = await loadKnowledge(cfg, [event]);

    expect(catalog.notes).toHaveLength(2);
    expect(catalog.notes.every(({ subjectKey }) => subjectKey === null)).toBe(true);
    expect(catalog.warnings).toEqual([]);
  });

  it("skips unsafe and oversized class notes without following docs or nested directories", async () => {
    const folder = "/synthetic/vault/Sem01/02-legacy-ue/term";
    directories.set(folder, [
      { name: "../outside.md", path: "ignored", size: 10 },
      { name: "nested/note.md", path: "ignored", size: 10 },
      { name: "Too large.md", path: "ignored", size: MAX_KNOWLEDGE_BYTES + 1 },
      { name: ".hidden.md", path: "ignored", size: 10 },
      { name: "Topic.md", path: "/outside/Topic.md", size: 10 },
    ]);
    files.set(`${folder}/Topic.md`, "# Topic\n");

    const catalog = await loadKnowledge(cfg, [event]);

    expect(catalog.notes).toMatchObject([{ path: "Sem01/02-legacy-ue/term/Topic.md", subjectKey: "coding" }]);
    expect(catalog.warnings).toHaveLength(2);
    expect(calls.filter(({ command }) => command === "list_docs").every(({ args }) => !String(args.dir).includes("/docs") && !String(args.dir).includes("/nested"))).toBe(true);
    expect(calls.filter(({ command }) => command === "read_text_file").map(({ args }) => args.path))
      .toEqual([indexPath, subjectPath, `${folder}/Topic.md`]);
  });

  it("limits concurrent file reads to eight", async () => {
    delayedReads = true;
    entries = Array.from({ length: 17 }, (_, index) => ({ name: `Note-${index}.md`, path: "ignored", size: 10 }));

    await loadKnowledge(cfg, []);

    expect(peakReads).toBe(8);
    expect(activeReads).toBe(0);
  });

  it("assigns live notes to the existing shared subject and excludes other semesters", async () => {
    entries = [
      { name: "Sakai - current.md", path: "ignored", size: 200 },
      { name: "Sakai - old.md", path: "ignored", size: 200 },
      { name: "Sakai - unknown.md", path: "ignored", size: 200 },
    ];
    const current = '---\nsakai_sync: v1\nsakai_semester: Sem01\nsakai_subject_key: coding\nfach: Coding\n---\n# Sakai Live: Coding\n';
    files.set("/synthetic/vault/Studium/Sakai - current.md", current);
    files.set("/synthetic/vault/Studium/Sakai - old.md", current.replace("Sem01", "Sem00"));
    files.set("/synthetic/vault/Studium/Sakai - unknown.md", current.replace("key: coding", "key: missing"));
    const catalog = await loadKnowledge(cfg, [event]);
    expect(catalog).toMatchObject({ warnings: [], notes: [{ title: "Sakai Live: Coding", subjectKey: "coding" }] });
    expect(catalog.notes).toHaveLength(1);
  });

  it("merges subject and general notes, sorts by title, and keeps relative paths and subject ownership", async () => {
    entries = [{ name: "General.md", path: generalPath, size: 40 }];
    files.set(subjectPath, subjectRaw);
    files.set(generalPath, "# Allgemeines\n\nExample guidance.\n");
    const before = [...files];
    const lecture: StudyEvent = {
      ...event, uid: "example-vo", typ: "VO", lvNummer: "CODE-VO", fachDir: "01-legacy-vo",
      terminRel: "01-legacy-vo/term", subjectDir: undefined, subjectFile: undefined,
    };

    const catalog = await loadKnowledge(cfg, [lecture, event]);

    expect(catalog).toMatchObject({ warnings: [], notes: [
      { title: "Allgemeines", path: "Studium/General.md", subjectKey: null },
      { title: "Coding", path: "Sem01/07-coding/Coding - Sakai.md", subjectKey: "coding" },
    ] });
    expect(calls.filter(({ command }) => command === "read_text_file").map(({ args }) => args.path))
      .toEqual([indexPath, subjectPath, generalPath]);
    expect([...files]).toEqual(before);
  });

  it("returns an empty catalog for missing notes without creating folders, notes, or configuration", async () => {
    const catalog = await loadKnowledge(cfg, [event]);

    expect(catalog).toEqual({ notes: [], warnings: [] });
    expect(files.size).toBe(0);
    expect(calls.filter(({ command }) => command === "list_docs").map(({ args }) => args.dir)).toEqual([
      "/synthetic/vault/Studium", "/synthetic/vault/Sem01/07-coding", "/synthetic/vault/Sem01/02-legacy-ue", "/synthetic/vault/Sem01/02-legacy-ue/term",
    ]);
    expect(calls.filter(({ command }) => command === "read_text_file").map(({ args }) => args.path)).toEqual([indexPath, subjectPath]);
  });

  it("retains subject notes when the general knowledge directory cannot be listed", async () => {
    files.set(subjectPath, subjectRaw);
    errors.set("list_docs:/synthetic/vault/Studium", new Error("Example directory unavailable"));

    const catalog = await loadKnowledge(cfg, [event]);

    expect(catalog.notes).toMatchObject([{ title: "Coding", subjectKey: "coding" }]);
    expect(catalog.warnings).toHaveLength(1);
    expect(catalog.warnings[0]).toContain("Studium");
  });

  it("retains readable notes when another read fails and does not expose raw filesystem errors", async () => {
    entries = [{ name: "General.md", path: generalPath, size: 20 }];
    files.set(generalPath, "# General\n");
    errors.set(`read_text_file:${subjectPath}`, new Error("EIO /synthetic/internal/details"));

    const catalog = await loadKnowledge(cfg, [event]);

    expect(catalog.notes).toMatchObject([{ path: "Studium/General.md" }]);
    expect(catalog.warnings).toHaveLength(1);
    expect(catalog.warnings[0]).toContain("Coding - Sakai.md");
    expect(catalog.warnings[0]).not.toContain("/synthetic/internal/details");
  });

  it.each([
    "---\nfach: [broken\n---\n# Broken\n",
    "---\nsource_url: https://example.test/course\nhinweise:\n  - bestaetigt: true\n    zeitpunkt: 2026-02-30T12:00:00Z\n---\n# Invalid\n",
  ])("isolates a malformed note while keeping other notes available: %s", async (raw) => {
    entries = [{ name: "General.md", path: generalPath, size: raw.length }];
    files.set(generalPath, raw);
    files.set(subjectPath, subjectRaw);

    const catalog = await loadKnowledge(cfg, [event]);

    expect(catalog.notes).toMatchObject([{ title: "Coding" }]);
    expect(catalog.warnings).toHaveLength(1);
    expect(catalog.warnings[0]).toContain("General.md");
  });

  it("does not import appointment UID notes into knowledge or modify them", async () => {
    const raw = "---\nuid: event@example.test\nvorbereitet: true\n---\n# Appointment\n";
    entries = [{ name: "General.md", path: generalPath, size: raw.length }];
    files.set(generalPath, raw);
    files.set(subjectPath, raw);

    expect(await loadKnowledge(cfg, [event])).toEqual({ notes: [], warnings: [] });
    expect([...files.values()]).toEqual([raw, raw]);
  });

  it("ignores hidden files and non-Markdown documents without reading them", async () => {
    entries = [
      { name: ".hidden.md", path: "/synthetic/vault/Studium/.hidden.md", size: 10 },
      { name: "Document.pdf", path: "/synthetic/vault/Studium/Document.pdf", size: 10 },
      { name: "General.md", path: generalPath, size: 10 },
    ];
    files.set(generalPath, "# General\n");

    const catalog = await loadKnowledge(cfg, []);

    expect(catalog.warnings).toEqual([]);
    expect(calls.filter(({ command }) => command === "read_text_file").map(({ args }) => args.path)).toEqual([generalPath]);
  });

  it.each(["nested/note.md", "nested\\note.md", "%2e%2e.md", "Bad#heading.md", "Bad?query.md", " Bad.md", "scheme:note.md"])("skips an unsafe entry and still reads subsequent valid notes: %s", async (name) => {
    entries = [
      { name, path: `/synthetic/vault/Studium/${name}`, size: 10 },
      { name: "General.md", path: generalPath, size: 10 },
    ];
    files.set(generalPath, "# General\n");

    const catalog = await loadKnowledge(cfg, []);

    expect(catalog.notes).toMatchObject([{ path: "Studium/General.md" }]);
    expect(catalog.warnings).toHaveLength(1);
    expect(calls.filter(({ command }) => command === "read_text_file").map(({ args }) => args.path)).toEqual([generalPath]);
  });

  it("constructs general paths inside the configured vault without trusting entry paths", async () => {
    entries = [{ name: "General.md", path: "/synthetic/other-vault/General.md", size: 10 }];
    files.set(generalPath, "# General\n");

    const catalog = await loadKnowledge(cfg, []);

    expect(catalog.notes).toMatchObject([{ path: "Studium/General.md" }]);
    expect(calls.filter(({ command }) => command === "read_text_file").map(({ args }) => args.path)).toEqual([generalPath]);
  });

  it("skips oversized listed files before reading and accepts a file exactly at the byte limit", async () => {
    entries = [
      { name: "Large.md", path: "/synthetic/vault/Studium/Large.md", size: MAX_KNOWLEDGE_BYTES + 1 },
      { name: "General.md", path: generalPath, size: MAX_KNOWLEDGE_BYTES },
    ];
    files.set(generalPath, "é".repeat(MAX_KNOWLEDGE_BYTES / 2));

    const catalog = await loadKnowledge(cfg, []);

    expect(catalog.notes).toMatchObject([{ path: "Studium/General.md" }]);
    expect(catalog.warnings).toHaveLength(1);
    expect(calls.filter(({ command }) => command === "read_text_file").map(({ args }) => args.path)).toEqual([generalPath]);
  });

  it("rechecks actual UTF-8 size after reading a file that grew since listing", async () => {
    entries = [{ name: "General.md", path: generalPath, size: 10 }];
    files.set(generalPath, "é".repeat(MAX_KNOWLEDGE_BYTES / 2 + 1));
    files.set(subjectPath, subjectRaw);

    const catalog = await loadKnowledge(cfg, [event]);

    expect(catalog.notes).toMatchObject([{ title: "Coding" }]);
    expect(catalog.warnings).toHaveLength(1);
    expect(catalog.warnings[0]).toContain("General.md");
  });

  it("also enforces the byte limit on subject notes that were not listed", async () => {
    files.set(subjectPath, "x".repeat(MAX_KNOWLEDGE_BYTES + 1));

    const catalog = await loadKnowledge(cfg, [event]);

    expect(catalog.notes).toEqual([]);
    expect(catalog.warnings).toHaveLength(1);
    expect(catalog.warnings[0]).toContain("Coding - Sakai.md");
  });

  it("reads no more than the note limit and includes known subjects before general notes", async () => {
    entries = Array.from({ length: MAX_KNOWLEDGE_NOTES + 1 }, (_, index) => ({
      name: `Note-${index}.md`, path: `/synthetic/vault/Studium/Note-${index}.md`, size: 10,
    }));
    files = new Map(entries.map(({ path }) => [path, "# General\n"]));
    files.set(subjectPath, subjectRaw);

    const catalog = await loadKnowledge(cfg, [event]);

    expect(catalog.notes).toHaveLength(MAX_KNOWLEDGE_NOTES);
    expect(catalog.notes.some(({ subjectKey }) => subjectKey === "coding")).toBe(true);
    expect(catalog.warnings).toHaveLength(1);
    expect(catalog.warnings[0]).toContain(String(MAX_KNOWLEDGE_NOTES));
    expect(calls.filter(({ command, args }) => command === "read_text_file" && args.path !== indexPath)).toHaveLength(MAX_KNOWLEDGE_NOTES);
  });

  it("loads exactly the note limit without an overflow warning", async () => {
    entries = Array.from({ length: MAX_KNOWLEDGE_NOTES }, (_, index) => ({
      name: `Note-${index}.md`, path: `/synthetic/vault/Studium/Note-${index}.md`, size: 10,
    }));
    files = new Map(entries.map(({ path }) => [path, "# General\n"]));

    const catalog = await loadKnowledge(cfg, []);

    expect(catalog.notes).toHaveLength(MAX_KNOWLEDGE_NOTES);
    expect(catalog.warnings).toEqual([]);
  });

  it("deduplicates repeated discovered paths before reading", async () => {
    const entry = { name: "General.md", path: generalPath, size: 10 };
    entries = [entry, entry];
    files.set(generalPath, "# General\n");

    const catalog = await loadKnowledge(cfg, []);

    expect(catalog.notes).toHaveLength(1);
    expect(calls.filter(({ command }) => command === "read_text_file")).toHaveLength(1);
  });

  it("preserves a vault directory's trailing space in every filesystem path", async () => {
    const spacedCfg = { ...cfg, basisPfad: "/synthetic/vault " };
    const spacedSubject = "/synthetic/vault /Sem01/07-coding/Coding - Sakai.md";
    const spacedGeneral = "/synthetic/vault /Studium/General.md";
    entries = [{ name: "General.md", path: spacedGeneral, size: 10 }];
    files.set(spacedSubject, subjectRaw);
    files.set(spacedGeneral, "# General\n");

    const catalog = await loadKnowledge(spacedCfg, [event]);

    expect(catalog.notes).toHaveLength(2);
    expect(catalog.warnings).toEqual([]);
    expect(calls.find(({ command }) => command === "list_docs")?.args.dir).toBe("/synthetic/vault /Studium");
    expect(calls.filter(({ command }) => command === "read_text_file").map(({ args }) => args.path))
      .toEqual(["/synthetic/vault /Sem01/.mci-manager/event-paths.json", spacedSubject, spacedGeneral]);
  });
});
