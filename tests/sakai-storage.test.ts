// @vitest-environment happy-dom
// @vitest-environment-options {"happyDOM":{"settings":{"disableCSSFileLoading":true,"disableJavaScriptFileLoading":true,"navigation":{"disableChildFrameNavigation":true,"disableMainFrameNavigation":true}}}}
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_KNOWLEDGE_BYTES } from "../src/lib/knowledge";
import { parseNote } from "../src/lib/notes";
import { MAX_SAKAI_PDF_BYTES, sakaiHash, type SakaiResource, type SakaiSnapshot } from "../src/lib/sakai";
import { syncSakai } from "../src/lib/sakaiStorage";
import type { StudyEvent } from "../src/lib/types";

const restoreDOM = vi.hoisted(() => {
  const descriptor = Object.getOwnPropertyDescriptor(Node.prototype, "nodeName")!;
  const iterator = document.createNodeIterator;
  // happy-dom requires the same sanitizer compatibility fix as md-preview.test.ts.
  Object.defineProperty(Node.prototype, "nodeName", { ...descriptor, get(this: Node): string {
    let prototype = Object.getPrototypeOf(this);
    while (prototype && prototype !== Node.prototype) {
      const getter = Object.getOwnPropertyDescriptor(prototype, "nodeName")?.get;
      if (getter) return getter.call(this);
      prototype = Object.getPrototypeOf(prototype);
    }
    return descriptor.get!.call(this);
  } });
  document.createNodeIterator = function (...args) {
    const result = iterator.apply(this, args);
    const nodes: Node[] = [];
    let node: Node | null;
    while ((node = result.nextNode())) nodes.push(node);
    let index = 0;
    result.nextNode = () => nodes[index++] ?? null;
    return result;
  };
  return () => {
    Object.defineProperty(Node.prototype, "nodeName", descriptor);
    document.createNodeIterator = iterator;
  };
});
afterAll(restoreDOM);

const cfg = { basisPfad: "/synthetic/sakai-vault", semester: "Sem01" };
const origin = "https://sakai.mci4me.at";
const pdfPath = `Studium/Quellen/Sakai-${"a".repeat(64)}.pdf`;
const resource: SakaiResource = {
  title: "Script", url: `${origin}/access/content/group/example-ue/script.pdf`, type: "application/pdf",
  size: 1024, modifiedDate: "2026-09-22T08:00:00Z",
};
const snapshot: SakaiSnapshot = {
  site: { id: "example-ue", title: "Coding UE", description: "<p>Course description</p>" },
  announcements: [{ id: "one", title: "Update", body: "<p>Current source text</p>", createdOn: 1790074800000 }],
  resources: [resource], warnings: [],
};
const event: StudyEvent = {
  uid: "example", summary: "Coding UE", fach: "Coding", typ: "UE", dozent: "Example", lvNummer: "CODE-UE",
  fachKey: "coding", fachDir: "01-coding", terminRel: "01-coding/term",
  start: "2026-09-22T08:00:00.000Z", end: "2026-09-22T09:00:00.000Z",
};
const selections = [{ siteId: "example-ue", subjectKey: "coding" }];
const generalSelection = { siteId: "example-general", subjectKey: null };
let files: Map<string, string>;
let snapshots: Map<string, SakaiSnapshot>;
let errors: Map<string, unknown>;
let calls: Array<{ command: string; args: Record<string, unknown> }>;
let beforeInvoke: ((command: string, args: Record<string, unknown>) => void) | undefined;
let current: boolean;
let localPdf: string;
let pdfBytes: unknown;
let pdfSizes: Map<string, number>;
let options: { isCurrent: () => boolean; onProgress: ReturnType<typeof vi.fn<(message: string) => void>> };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-22T10:00:00Z"));
  files = new Map();
  snapshots = new Map([
    ["example-ue", structuredClone(snapshot)],
    ["example-vo", { ...structuredClone(snapshot), site: { id: "example-vo", title: "Coding VO", description: "" }, resources: [] }],
    ["example-general", { ...structuredClone(snapshot), site: { id: "example-general", title: "General", description: "" }, resources: [] }],
  ]);
  errors = new Map();
  calls = [];
  beforeInvoke = undefined;
  current = true;
  localPdf = pdfPath;
  pdfBytes = 1024;
  pdfSizes = new Map();
  options = { isCurrent: () => current, onProgress: vi.fn() };
  mockIPC((command, payload) => {
    const args = (payload ?? {}) as Record<string, unknown>;
    calls.push({ command, args });
    beforeInvoke?.(command, args);
    const key = `${command}:${args.path ?? args.dir ?? args.url ?? args.siteId}`;
    if (errors.has(key)) throw errors.get(key);
    const path = args.path as string;
    switch (command) {
      case "plugin:path|join": return (args.paths as string[]).join("/");
      case "read_text_file":
        if (path.endsWith(".pdf")) throw new Error("Binary files must never be read as text");
        return files.get(path) ?? null;
      case "list_docs": {
        const prefix = `${args.dir}/`;
        return [...files].filter(([name]) => name.startsWith(prefix) && !name.slice(prefix.length).includes("/"))
          .map(([path, content]) => ({ name: path.slice(prefix.length), path, size: new TextEncoder().encode(content).length }));
      }
      case "save_text_file":
        if ((files.get(path) ?? null) !== args.expected) throw "CONFLICT";
        files.set(path, args.content as string);
        return;
      case "ensure_dir": return;
      case "sakai_site_snapshot": return structuredClone(snapshots.get(args.siteId as string));
      case "sakai_download_pdf":
        files.set(`${args.root}/${localPdf}`, "SYNTHETIC_PDF_BYTES");
        return { path: localPdf, bytes: pdfSizes.get(args.url as string) ?? pdfBytes };
      default: throw new Error(`Unexpected IPC command: ${command}`);
    }
  });
});

afterEach(() => { clearMocks(); vi.useRealTimers(); });

describe("syncSakai generated note ownership", () => {
  it("merges UE and VO into one canonical note and keeps general sites separate", async () => {
    const result = await syncSakai(cfg, [event], [...selections, { siteId: "example-vo", subjectKey: "coding" }, generalSelection], options);
    const notes = [...files].filter(([path]) => path.endsWith(".md"));
    const course = notes.find(([, raw]) => parseNote(raw).data.sakai_subject_key === "coding")!;

    expect(result).toEqual({ updated: 2, unchanged: 0, downloaded: 1, warnings: [], completedAt: "2026-09-22T10:00:00.000Z" });
    expect(notes).toHaveLength(2);
    expect(course[0]).toMatch(/\/Studium\/Sakai Live - Coding - Sem01 - [a-f0-9]{64}\.md$/);
    expect(parseNote(course[1]).data.source_urls).toEqual([`${origin}/portal/site/example-ue`, `${origin}/portal/site/example-vo`]);
    expect(course[1]).toContain("# Sakai Live: Coding");
    expect(course[1]).toContain("Ankündigungen der letzten 365 Tage");
    expect(course[1]).toMatch(/Veröffentlicht: 2026-09-22/);
    expect(course[1]).toContain(`[[${pdfPath}|PDF lokal]]`);
  });

  it("leaves curated notes, MOCs, calendar and event indexes untouched", async () => {
    const originals = [
      [`${cfg.basisPfad}/Studium/Curated.md`, "# Personal knowledge"],
      [`${cfg.basisPfad}/Sem01/Coding.md`, "# Course MOC"],
      [`${cfg.basisPfad}/.mci-manager/calendar.ics`, "SYNTHETIC_CALENDAR"],
      [`${cfg.basisPfad}/Sem01/.mci-manager/event-paths.json`, "{}"],
    ] as const;
    files = new Map(originals);

    await syncSakai(cfg, [event], selections, options);

    expect(originals.map(([path]) => files.get(path))).toEqual(originals.map(([, raw]) => raw));
    expect(calls.filter(({ command }) => /delete|assignment|grade|submission|calendar/.test(command))).toEqual([]);
    expect(calls.filter(({ command }) => command === "save_text_file").every(({ args }) => Object.hasOwn(args, "expected"))).toBe(true);
  });

  it("links merged UE and VO to their indexed course MOC and current semester", async () => {
    const nextCfg = { ...cfg, semester: "Sem02" };
    const events = [event, { ...event, uid: "lecture", typ: "VO" as const, fachDir: "02-coding-vo",
      subjectDir: "03-coding", subjectFile: "Coding Übersicht.md" }];
    files.set(`${cfg.basisPfad}/Sem01/_Semester.md`, "# Previous semester");
    files.set(`${cfg.basisPfad}/Sem02/_Semester.md`, "# Current semester");
    files.set(`${cfg.basisPfad}/Sem02/03-coding/Coding Übersicht.md`, "# Canonical course MOC");
    files.set(`${cfg.basisPfad}/Sem02/01-coding/Coding.md`, "# Legacy UE MOC");

    const result = await syncSakai(nextCfg, events, [...selections, { siteId: "example-vo", subjectKey: "coding" }], options);
    const notes = [...files].filter(([path]) => path.includes("/Studium/Sakai Live - "));

    expect(result).toMatchObject({ updated: 1, warnings: [] });
    expect(notes).toHaveLength(1);
    expect(notes[0][1]).toContain("[[Sem02/_Semester|Sem02]] · [[Sem02/03-coding/Coding Übersicht|Coding]]");
    expect(notes[0][1]).not.toMatch(/\[\[Sem01\/|\[\[Sem02\/01-coding\/|\[\[Sem02\/02-coding-vo\//);
  });

  it("links general sites to existing Studienwissen and the current semester", async () => {
    snapshots.get("example-general")!.site.title = "My Bachelor";
    files.set(`${cfg.basisPfad}/Sem01/_Semester.md`, "# Semester");
    files.set(`${cfg.basisPfad}/Studium/Studienwissen.md`, "# Studienwissen");

    const result = await syncSakai(cfg, [event], [generalSelection], options);
    const raw = [...files].find(([path]) => path.includes("/Studium/Sakai Live - "))![1];

    expect(result).toMatchObject({ updated: 1, warnings: [] });
    expect(raw).toContain("[[Sem01/_Semester|Sem01]] · [[Studium/Studienwissen|Studienwissen]]");
    expect(raw).not.toContain("[[Sem01/01-coding/");
  });

  it("omits missing navigation targets without guessing a similarly named course note", async () => {
    snapshots.get("example-ue")!.resources = [];
    files.set(`${cfg.basisPfad}/Sem01/01-coding/Coding.md`, "# Different course file");
    files.set(`${cfg.basisPfad}/Sem02/_Semester.md`, "# Another semester");

    const result = await syncSakai(cfg, [{ ...event, subjectFile: "Canonical.md" }], [...selections, generalSelection], options);
    const notes = [...files].filter(([path]) => path.includes("/Studium/Sakai Live - "));

    expect(result).toMatchObject({ updated: 2, warnings: [] });
    expect(notes.map(([, raw]) => raw.match(/\[\[[^\]]+\]\]/g))).toEqual([null, null]);
  });

  it("upgrades a valid legacy prefix with course links while preserving its exact personal suffix", async () => {
    await syncSakai(cfg, [event], selections, options);
    const [path, initial] = [...files].find(([path]) => path.endsWith(".md"))!;
    const marker = initial.match(/<!-- sm:sakai:[a-f0-9]{64} -->/)![0];
    const personal = "\r\n\r\n## Persönliche Notizen\r\n  Keep\t東京\r\n\uFEFF\n";
    files.set(path, initial.slice(0, initial.indexOf(marker) + marker.length) + personal);
    files.set(`${cfg.basisPfad}/Sem01/_Semester.md`, "# Semester");
    files.set(`${cfg.basisPfad}/Sem01/01-coding/Coding.md`, "# Coding");

    const result = await syncSakai(cfg, [event], selections, options);
    const updated = files.get(path)!;
    const nextMarker = /<!-- sm:sakai:([a-f0-9]{64}) -->/.exec(updated)!;

    expect(initial).not.toContain("[[Sem01/");
    expect(result).toMatchObject({ updated: 1, warnings: [] });
    expect(updated).toContain("[[Sem01/01-coding/Coding|Coding]]");
    expect(updated.slice(nextMarker.index + nextMarker[0].length)).toBe(personal);
    expect(await sakaiHash(updated.slice(0, nextMarker.index))).toBe(nextMarker[1]);
  });

  it.each([
    { subjectDir: "../outside", subjectFile: "Coding.md" },
    { subjectDir: "01-coding", subjectFile: "../outside.md" },
    { subjectDir: "01-coding", subjectFile: "Coding]] [[Secret.md" },
  ])("rejects unsafe canonical course paths before reading them: %j", async (subject) => {
    const result = await syncSakai(cfg, [{ ...event, ...subject }], selections, options);

    expect(result).toMatchObject({ updated: 0, warnings: [expect.stringContaining("vorhandene Notiz bleibt unverändert")] });
    expect(calls.filter(({ command, args }) => command === "read_text_file" && /outside|Secret/.test(String(args.path)))).toEqual([]);
  });

  it("preserves the entire personal suffix byte-for-byte when source lessons change", async () => {
    await syncSakai(cfg, [event], selections, options);
    const [path, initial] = [...files].find(([path]) => path.endsWith(".md"))!;
    const marker = initial.match(/<!-- sm:sakai:[a-f0-9]{64} -->/)![0];
    const personal = "\r\n\r\n## Persönlich\r\nKeep  spaces\t東京\r\n\uFEFF\n";
    files.set(path, initial.slice(0, initial.indexOf(marker) + marker.length) + personal);
    snapshots.get("example-ue")!.lessons = [{ title: "New lesson", html: "<p>Updated material</p>", url: `${origin}/portal/site/example-ue/page/lesson` }];

    const result = await syncSakai(cfg, [event], selections, options);

    expect(result.updated).toBe(1);
    expect(files.get(path)).toContain("Updated material");
    expect(files.get(path)!.endsWith(personal)).toBe(true);
  });

  it.each(["unmarked", "modified-prefix", "duplicate-marker"])("preserves existing content on %s conflicts and continues other groups", async (kind) => {
    await syncSakai(cfg, [event], selections, options);
    const [path, initial] = [...files].find(([path]) => path.endsWith(".md"))!;
    const variants = {
      unmarked: "# Existing personal file\n",
      "modified-prefix": initial.replace("Current source text", "Manual source edit"),
      "duplicate-marker": initial + "\n<!-- sm:sakai:" + "b".repeat(64) + " -->",
    };
    const raw = variants[kind as keyof typeof variants];
    files.set(path, raw);

    const result = await syncSakai(cfg, [event], [...selections, generalSelection], options);

    expect(files.get(path)).toBe(raw);
    expect(result).toMatchObject({ updated: 1, unchanged: 0, warnings: [expect.stringContaining("Bearbeitungskonflikt")] });
  });

  it("retains a concurrent note edit through expected-CAS and continues other groups", async () => {
    await syncSakai(cfg, [event], selections, options);
    const [path] = [...files].find(([path]) => path.endsWith(".md"))!;
    snapshots.get("example-ue")!.announcements[0].body = "Changed remotely";
    beforeInvoke = (command, args) => { if (command === "save_text_file" && args.path === path) files.set(path, "Concurrent personal edit"); };

    const result = await syncSakai(cfg, [event], [...selections, generalSelection], options);

    expect(files.get(path)).toBe("Concurrent personal edit");
    expect(result).toMatchObject({ updated: 1, warnings: [expect.stringContaining("Bearbeitungskonflikt")] });
  });

  it("reuses the stable identity path when an unmapped site's title changes", async () => {
    await syncSakai(cfg, [], [generalSelection], options);
    const [path] = [...files].find(([path]) => path.endsWith(".md"))!;
    snapshots.get("example-general")!.site.title = "Renamed general site";

    const result = await syncSakai(cfg, [], [generalSelection], options);

    expect([...files.keys()].filter((path) => path.endsWith(".md"))).toEqual([path]);
    expect(files.get(path)).toContain("# Sakai Live: Renamed general site");
    expect(result.updated).toBe(1);
  });

  it("uses distinct stable paths for two semesters", async () => {
    await syncSakai(cfg, [event], selections, options);
    await syncSakai({ ...cfg, semester: "Sem02" }, [event], selections, options);

    expect([...files.keys()].filter((path) => path.endsWith(".md"))).toHaveLength(2);
    expect([...files.keys()].filter((path) => path.endsWith(".json"))).toHaveLength(2);
  });

  it("preserves an existing note when its prefix plus personal suffix exceeds the reader limit", async () => {
    await syncSakai(cfg, [event], selections, options);
    const [path, initial] = [...files].find(([path]) => path.endsWith(".md"))!;
    const raw = initial + "é".repeat(MAX_KNOWLEDGE_BYTES / 2);
    files.set(path, raw);
    snapshots.get("example-ue")!.announcements[0].body = "New source";

    const result = await syncSakai(cfg, [event], selections, options);

    expect(files.get(path)).toBe(raw);
    expect(result).toMatchObject({ updated: 0, warnings: [expect.stringContaining("vorhandene Notiz bleibt unverändert")] });
  });
});

describe("Sakai course freshness", () => {
  it.each([
    { prioritySubjectKey: undefined, firstSite: "example-ue" },
    { prioritySubjectKey: "next", firstSite: "example-general" },
  ])("prioritizes the open subject or today's class before old pending downloads: %j", async ({ prioritySubjectKey, firstSite }) => {
    const upcoming = { ...event, uid: "next", fach: "Next", fachKey: "next", fachDir: "02-next", lvNummer: "NEXT",
      start: "2026-09-23T08:00:00.000Z", end: "2026-09-23T09:00:00.000Z" };
    const path = `${cfg.basisPfad}/.mci-manager/sakai-${await sakaiHash(cfg.semester)}.json`;
    files.set(path, JSON.stringify({ version: "v1", semester: cfg.semester, pdfs: [],
      pending: [`${origin}/access/content/group/example-general/old.pdf`] }));

    await syncSakai(cfg, [event, upcoming], [...selections, { ...generalSelection, subjectKey: "next" }], { ...options, prioritySubjectKey });

    expect(calls.filter(({ command }) => command === "sakai_site_snapshot")[0].args.siteId).toBe(firstSite);
  });

  it("imports a same-day introduction update and newly uploaded course files on the next refresh", async () => {
    await syncSakai(cfg, [event], selections, options);
    const [path, initial] = [...files].find(([path]) => path.endsWith(".md"))!;
    files.set(path, `${initial}\nMy lecture notes`);
    snapshots.get("example-ue")!.site.description = "<p>Introduction for today's class</p>";
    snapshots.get("example-ue")!.resources.push(
      { ...resource, title: "Today's PDF", url: `${origin}/access/content/group/example-ue/today.pdf` },
      { ...resource, title: "Presentation", type: "application/vnd.openxmlformats-officedocument.presentationml.presentation", url: `${origin}/access/content/group/example-ue/today.pptx` },
    );
    calls = [];

    const result = await syncSakai(cfg, [event], selections, options);

    expect(result).toMatchObject({ updated: 1, downloaded: 1, warnings: [] });
    expect(files.get(path)).toContain("Introduction for today&#39;s class");
    expect(files.get(path)).toContain("/today.pdf)");
    expect(files.get(path)).toContain("/today.pptx)");
    expect(files.get(path)).toContain(`[[${pdfPath}|PDF lokal]]`);
    expect(files.get(path)).toContain("My lecture notes");
    expect(calls.filter(({ command }) => command === "sakai_download_pdf")).toHaveLength(1);
  });
});

describe("Sakai PDF idempotence and budgets", () => {
  it("performs no writes on an unchanged same-Vienna-date run and checks PDF existence by one listing", async () => {
    await syncSakai(cfg, [event], selections, options);
    const before = [...files];
    calls = [];
    vi.setSystemTime(new Date("2026-09-22T18:00:00Z"));

    const result = await syncSakai(cfg, [event], selections, options);

    expect([...files]).toEqual(before);
    expect(result).toMatchObject({ updated: 0, unchanged: 1, downloaded: 0, warnings: [] });
    expect(calls.filter(({ command }) => command === "save_text_file" || command === "sakai_download_pdf")).toEqual([]);
    expect(calls.filter(({ command, args }) => command === "list_docs" && args.dir === `${cfg.basisPfad}/Studium/Quellen`)).toHaveLength(1);
    expect(calls.filter(({ command, args }) => command === "read_text_file" && String(args.path).endsWith(".pdf"))).toEqual([]);
  });

  it("uses Vienna's new date even before UTC midnight", async () => {
    await syncSakai(cfg, [event], selections, options);
    vi.setSystemTime(new Date("2026-09-22T22:30:00Z"));

    await syncSakai(cfg, [event], selections, options);

    expect(parseNote([...files].find(([path]) => path.endsWith(".md"))![1]).data.abgerufen).toBe("2026-09-23");
  });

  it("redownloads unknown modification dates while retaining byte-identical note and PDF paths", async () => {
    snapshots.get("example-ue")!.resources[0].modifiedDate = null;
    await syncSakai(cfg, [event], selections, options);
    const before = [...files];
    calls = [];

    const result = await syncSakai(cfg, [event], selections, options);

    expect(result).toMatchObject({ updated: 0, unchanged: 1, downloaded: 1 });
    expect([...files]).toEqual(before);
    expect(calls.filter(({ command }) => command === "sakai_download_pdf")).toHaveLength(1);
  });

  it.each(["size", "modifiedDate", "missing-local"])("redownloads PDFs when %s changes", async (field) => {
    await syncSakai(cfg, [event], selections, options);
    const changes = {
      size: () => { snapshots.get("example-ue")!.resources[0].size++; },
      modifiedDate: () => { snapshots.get("example-ue")!.resources[0].modifiedDate = "2026-09-23T08:00:00Z"; },
      "missing-local": () => { files.delete(`${cfg.basisPfad}/${pdfPath}`); },
    };
    changes[field as keyof typeof changes]();
    calls = [];

    const result = await syncSakai(cfg, [event], selections, options);

    expect(result.downloaded).toBe(1);
    expect(calls.filter(({ command }) => command === "sakai_download_pdf")).toHaveLength(1);
  });

  it.each([0, 1, 25, 26, 188])("finishes all %s eligible PDFs in one sync without refetching the source", async (count) => {
    const resources = Array.from({ length: count }, (_, index) => ({
      ...resource, size: 1, url: `${origin}/access/content/group/example-ue/${String(index).padStart(3, "0")}.pdf`,
    }));
    snapshots.get("example-ue")!.resources = resources;
    const progressBeforeDownloads: string[] = [];
    beforeInvoke = (command) => {
      if (command === "sakai_download_pdf") progressBeforeDownloads.push(options.onProgress.mock.lastCall?.[0] ?? "");
    };

    const result = await syncSakai(cfg, [event], selections, options);

    expect(result).toMatchObject({ downloaded: count, warnings: [] });
    expect(calls.filter(({ command }) => command === "sakai_download_pdf").map(({ args }) => args.url))
      .toEqual(resources.map(({ url }) => url));
    expect(calls.filter(({ command }) => command === "sakai_site_snapshot")).toHaveLength(1);
    expect(progressBeforeDownloads.map((message) => Number(message.match(/(\d+) PDFs gespeichert/)?.[1])))
      .toEqual(Array.from({ length: count }, (_, index) => index));
    expect([...files].find(([path]) => path.endsWith(".md"))![1]).not.toContain("PDF-Abruf teilweise");
  });

  it("starts a new batch before downloading beyond the byte budget without lowering the per-file limit", async () => {
    const resources = Array.from({ length: 8 }, (_, index) => ({
      ...resource, size: 1, url: `${origin}/access/content/group/example-ue/${index}.pdf`,
    }));
    snapshots.get("example-ue")!.resources = resources;
    pdfBytes = MAX_SAKAI_PDF_BYTES;
    pdfSizes.set(resources[6].url, 10 * 1024 * 1024);
    const checkpointCounts: number[] = [];
    beforeInvoke = (command, args) => {
      if (command === "save_text_file" && String(args.path).endsWith(".json")) {
        checkpointCounts.push(calls.filter(({ command }) => command === "sakai_download_pdf").length);
      }
    };

    const result = await syncSakai(cfg, [event], selections, options);
    const downloads = calls.filter(({ command }) => command === "sakai_download_pdf");

    expect(result).toMatchObject({ downloaded: 8, warnings: [] });
    expect(downloads.map(({ args }) => args.maxBytes)).toEqual(Array(8).fill(MAX_SAKAI_PDF_BYTES));
    expect(checkpointCounts).toEqual([6, 8]);
  });

  it("downloads unknown modification dates once per URL across batches and sites, then rechecks on a later sync", async () => {
    const resources = Array.from({ length: 26 }, (_, index) => ({
      ...resource, modifiedDate: null, url: `${origin}/access/content/group/example-ue/${String(index).padStart(2, "0")}.pdf`,
    }));
    snapshots.get("example-ue")!.resources = [...resources, { ...resources[25], size: 2 }];
    const generalResource = { ...resource, modifiedDate: null, url: `${origin}/access/content/group/example-general/general.pdf` };
    snapshots.get("example-general")!.resources = [generalResource, generalResource];
    const all = [...selections, generalSelection];

    const first = await syncSakai(cfg, [event], all, options);
    const firstDownloads = calls.filter(({ command }) => command === "sakai_download_pdf");
    const firstSnapshots = calls.filter(({ command }) => command === "sakai_site_snapshot");
    calls = [];
    const second = await syncSakai(cfg, [event], all, options);

    expect(first).toMatchObject({ downloaded: 27, warnings: [] });
    expect(firstDownloads.map(({ args }) => args.url)).toEqual([...resources.map(({ url }) => url), generalResource.url]);
    expect(firstSnapshots).toHaveLength(2);
    expect(second).toMatchObject({ downloaded: 27, warnings: [] });
    expect(calls.filter(({ command }) => command === "sakai_download_pdf").map(({ args }) => args.url))
      .toEqual(firstDownloads.map(({ args }) => args.url));
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "1024", null, undefined, MAX_SAKAI_PDF_BYTES + 1])(
    "rejects an invalid native byte count %s instead of releasing the reserved budget", async (value) => {
      snapshots.get("example-ue")!.resources = Array.from({ length: 8 }, (_, index) => ({
        ...resource, url: `${origin}/access/content/group/example-ue/${index}.pdf`,
      }));
      pdfBytes = value;

      const result = await syncSakai(cfg, [event], selections, options);

      expect(result).toMatchObject({ downloaded: 0, warnings: [expect.stringContaining("8 PDFs: Download fehlgeschlagen")] });
      expect(calls.filter(({ command }) => command === "sakai_download_pdf")).toHaveLength(8);
      expect([...files].find(([path]) => path.endsWith(".md"))![1]).not.toContain("[[Studium/Quellen/");
    },
  );

  it("attempts failed URLs once and continues to later PDFs in the same sync", async () => {
    const resources = Array.from({ length: 9 }, (_, index) => ({
      ...resource, url: `${origin}/access/content/group/example-ue/${index}.pdf`,
    }));
    snapshots.get("example-ue")!.resources = [...resources, resources[0]];
    errors = new Map(resources.slice(0, 7).map(({ url }) => [`sakai_download_pdf:${url}`, "Denied"]));

    const result = await syncSakai(cfg, [event], selections, options);

    expect(result).toMatchObject({ downloaded: 2, warnings: [expect.stringContaining("7 PDFs: Download fehlgeschlagen")] });
    expect(calls.filter(({ command }) => command === "sakai_download_pdf").map(({ args }) => args.url))
      .toEqual(resources.map(({ url }) => url));
  });

  it("downloads the exact per-file boundary and keeps oversized, unknown and other-format resources as links", async () => {
    snapshots.get("example-ue")!.resources = [
      { ...resource, size: MAX_SAKAI_PDF_BYTES },
      { ...resource, size: MAX_SAKAI_PDF_BYTES + 1, url: `${origin}/access/content/group/example-ue/large.pdf` },
      { ...resource, size: 0, url: `${origin}/access/content/group/example-ue/unknown.pdf` },
      { ...resource, type: "application/zip", url: `${origin}/access/content/group/example-ue/files.zip` },
      { ...resource, url: "https://external.test/file.pdf" },
    ];

    const result = await syncSakai(cfg, [event], selections, options);
    const raw = [...files].find(([path]) => path.endsWith(".md"))![1];

    expect(result.downloaded).toBe(1);
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings).toContain("2 PDFs: Dateigröße unbekannt oder über 15 MiB; nur als Link verfügbar.");
    expect(raw).toContain("/large.pdf)");
    expect(raw).toContain("/files.zip)");
    expect(raw).toContain("https://external.test/file.pdf)");
  });

  it("never downloads unsafe URLs or PDFs belonging to another site", async () => {
    snapshots.get("example-ue")!.resources = [
      { ...resource, url: "javascript:alert(1)" },
      { ...resource, url: `${origin}/access/content/group/example-other/script.pdf` },
    ];

    const result = await syncSakai(cfg, [event], selections, options);

    expect(result).toMatchObject({ downloaded: 0, updated: 1 });
    expect(result.warnings).toHaveLength(2);
    expect(calls.filter(({ command }) => command === "sakai_download_pdf")).toEqual([]);
  });
});

describe("Sakai source errors and partial PDF downloads", () => {
  it("keeps an entire UE/VO snapshot when one source fails while updating another group", async () => {
    const all = [...selections, { siteId: "example-vo", subjectKey: "coding" }];
    const initial = await syncSakai(cfg, [event], all, options);
    const [path, raw] = [...files].find(([path]) => path.endsWith(".md"))!;
    snapshots.get("example-ue")!.announcements[0].body = "New text";
    errors.set("sakai_site_snapshot:example-vo", new Error("SYNTHETIC_PRIVATE_ERROR_DETAIL"));
    calls = [];

    const result = await syncSakai(cfg, [event], [...all, generalSelection], options);

    expect(initial.failedSubjectKeys).toBeUndefined();
    expect(files.get(path)).toBe(raw);
    expect(result.failedSubjectKeys).toEqual(["coding"]);
    expect(result).toMatchObject({ updated: 1, warnings: [expect.stringContaining("vorhandene Notiz bleibt unverändert")] });
    expect(result.warnings.join()).not.toContain("SYNTHETIC_PRIVATE_ERROR_DETAIL");
    expect(calls.filter(({ command }) => command === "sakai_download_pdf")).toEqual([]);
  });

  it.each([
    ["site", "Kursinformationen"],
    ["announcements", "Ankündigungen"],
    ["resources", "Dateien"],
    ["lessons", "Lerninhalte"],
  ])("reports the safe native %s failure with its course and site while preserving the note", async (phase, label) => {
    const all = [...selections, { siteId: "example-vo", subjectKey: "coding" }];
    await syncSakai(cfg, [event], all, options);
    const [path, raw] = [...files].find(([path]) => path.endsWith(".md"))!;
    const reason = "Sakai-Antwort hat ein unbekanntes Datenformat";
    snapshots.get("example-ue")!.announcements[0].body = "New text";
    errors.set("sakai_site_snapshot:example-vo", `SAKAI_SNAPSHOT:${phase}:${reason}`);

    const result = await syncSakai(cfg, [event], [...all, generalSelection], options);

    expect(files.get(path)).toBe(raw);
    expect(result.failedSubjectKeys).toEqual(["coding"]);
    expect(result.updated).toBe(1);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("Coding");
    expect(result.warnings[0]).toContain(label);
    expect(result.warnings[0]).toContain("example-vo");
    expect(result.warnings[0]).toContain(reason);
    expect(result.warnings[0]).toContain("vorhandene Notiz bleibt unverändert");
  });

  it.each([
    "SAKAI_SNAPSHOT:resources:SYNTHETIC_PRIVATE_ERROR_DETAIL",
    "SAKAI_SNAPSHOT:resources:Sakai-Antwort hat ein unbekanntes Datenformat\n",
    "SAKAI_SNAPSHOT:resources:Sakai-Antwort hat ein unbekanntes Datenformat SYNTHETIC_PRIVATE_ERROR_DETAIL",
    "SAKAI_SNAPSHOT:resources:Sakai-Antwort hat ein unbekanntes Datenformat\nSYNTHETIC_PRIVATE_ERROR_DETAIL",
    "SYNTHETIC_PRIVATE_ERROR_DETAIL:SAKAI_SNAPSHOT:resources:Sakai-Antwort hat ein unbekanntes Datenformat",
    "SAKAI_SNAPSHOT:SYNTHETIC_PRIVATE_ERROR_DETAIL:Sakai-Antwort hat ein unbekanntes Datenformat",
    "SAKAI_SNAPSHOT:resources:SYNTHETIC_PRIVATE_ERROR_DETAIL:Sakai-Antwort hat ein unbekanntes Datenformat",
    "SAKAI_SNAPSHOT_INVALID:resources:Sakai-Antwort hat ein unbekanntes Datenformat",
  ])("does not expose an unrecognized or modified native diagnostic: %s", async (error) => {
    await syncSakai(cfg, [event], selections, options);
    const [path, raw] = [...files].find(([path]) => path.endsWith(".md"))!;
    errors.set("sakai_site_snapshot:example-ue", error);

    const result = await syncSakai(cfg, [event], selections, options);

    expect(files.get(path)).toBe(raw);
    expect(result.failedSubjectKeys).toEqual(["coding"]);
    expect(result).toMatchObject({ updated: 0, warnings: [
      "Coding: Der Abruf oder sichere Schreibzugriff ist fehlgeschlagen; die vorhandene Notiz bleibt unverändert.",
    ] });
    expect(result.warnings.join()).not.toContain("SYNTHETIC_PRIVATE_ERROR_DETAIL");
  });

  it.each([
    { selected: selections, siteId: "example-ue", failedSubjectKeys: ["coding"] },
    { selected: [generalSelection], siteId: "example-general", failedSubjectKeys: undefined },
  ])("preserves the old snapshot and marks only an assigned subject when $siteId is incomplete", async ({ selected, siteId, failedSubjectKeys }) => {
    await syncSakai(cfg, [event], selected, options);
    const before = [...files];
    snapshots.get(siteId)!.warnings = ["SYNTHETIC_PRIVATE_ERROR_DETAIL"];

    const result = await syncSakai(cfg, [event], selected, options);

    expect([...files]).toEqual(before);
    expect(result.updated).toBe(0);
    expect(result.warnings).toHaveLength(1);
    expect(result.failedSubjectKeys).toEqual(failedSubjectKeys);
  });

  it("continues new announcements after one PDF failure, marks partial results and retries later", async () => {
    errors.set(`sakai_download_pdf:${resource.url}`, new Error("Native permission or symlink boundary denied"));

    const first = await syncSakai(cfg, [event], selections, options);
    const raw = [...files].find(([path]) => path.endsWith(".md"))![1];
    errors.clear();
    const next = await syncSakai(cfg, [event], selections, options);

    expect(first).toMatchObject({ updated: 1, downloaded: 0, warnings: [expect.stringContaining("Download fehlgeschlagen")] });
    expect(raw).toContain("Current source text");
    expect(raw).toContain(resource.url);
    expect(raw).toContain("PDF-Abruf teilweise");
    expect(raw).not.toContain("[[Studium/Quellen/");
    expect(next).toMatchObject({ downloaded: 1, updated: 1, warnings: [] });
  });

  it("preserves a valid cached local PDF on failure when its metadata still matches", async () => {
    snapshots.get("example-ue")!.resources[0].modifiedDate = null;
    await syncSakai(cfg, [event], selections, options);
    errors.set(`sakai_download_pdf:${resource.url}`, "SYNTHETIC_FAILURE");
    snapshots.get("example-ue")!.announcements[0].body = "New announcement";

    const result = await syncSakai(cfg, [event], selections, options);
    const raw = [...files].find(([path]) => path.endsWith(".md"))![1];

    expect(result.updated).toBe(1);
    expect(raw).toContain("New announcement");
    expect(raw).toContain(`[[${pdfPath}|PDF lokal]]`);
    expect(raw).toContain("PDF-Abruf teilweise");
  });

  it.each(["../outside.pdf", "/absolute.pdf", "Studium/Quellen/Sakai-abcd.pdf", `Studium/Quellen/Sakai-${"A".repeat(64)}.pdf`])("rejects unsafe returned PDF paths: %s", async (path) => {
    localPdf = path;

    const result = await syncSakai(cfg, [event], selections, options);

    expect(result).toMatchObject({ updated: 1, downloaded: 0, warnings: [expect.stringContaining("Download fehlgeschlagen")] });
    expect([...files].find(([path]) => path.endsWith(".md"))![1]).not.toContain("[[Studium/Quellen/");
  });
});

describe("strict Sakai cache and compare-and-swap", () => {
  it.each(["null", "[]", "{broken", '{"version":"v2"}', '{"version":"v1","semester":"wrong","pdfs":[],"pending":[]}'])("preserves malformed cache data: %s", async (raw) => {
    const path = `${cfg.basisPfad}/.mci-manager/sakai-${await sakaiHash(cfg.semester)}.json`;
    files.set(path, raw);

    const result = await syncSakai(cfg, [event], selections, options);

    expect(files.get(path)).toBe(raw);
    expect(result).toMatchObject({ updated: 1, downloaded: 1, warnings: [expect.stringContaining("Cache ist nicht sicher lesbar")] });
  });

  it.each([
    { path: "../outside.pdf" }, { path: "/outside.pdf" }, { path: `${pdfPath}#injected` }, { path: `Studium/Quellen/Sakai-${"a".repeat(63)}.pdf` },
    { url: "https://other.test/file.pdf" }, { size: -1 }, { modifiedDate: 123 }, { extra: true },
  ])("rejects unsafe PDF cache records instead of reading arbitrary files", async (change) => {
    const path = `${cfg.basisPfad}/.mci-manager/sakai-${await sakaiHash(cfg.semester)}.json`;
    const raw = JSON.stringify({ version: "v1", semester: cfg.semester, pdfs: [{ url: resource.url, modifiedDate: resource.modifiedDate, size: resource.size, path: pdfPath, ...change }], pending: [] });
    files.set(path, raw);

    const result = await syncSakai(cfg, [event], selections, options);

    expect(files.get(path)).toBe(raw);
    expect(result.downloaded).toBe(1);
    expect(result.warnings).toEqual([expect.stringContaining("Cache ist nicht sicher lesbar")]);
    expect(calls.filter(({ command, args }) => command === "read_text_file" && !String(args.path).startsWith(cfg.basisPfad))).toEqual([]);
  });

  it("checkpoints every 25 attempts and uses each successful cache revision for the next save", async () => {
    snapshots.get("example-ue")!.resources = Array.from({ length: 51 }, (_, index) => ({
      ...resource, url: `${origin}/access/content/group/example-ue/${String(index).padStart(2, "0")}.pdf`,
    }));
    const path = `${cfg.basisPfad}/.mci-manager/sakai-${await sakaiHash(cfg.semester)}.json`;
    const checkpointCounts: number[] = [];
    beforeInvoke = (command, args) => {
      if (command === "save_text_file" && args.path === path) {
        checkpointCounts.push(calls.filter(({ command }) => command === "sakai_download_pdf").length);
      }
    };

    const result = await syncSakai(cfg, [event], selections, options);
    const writes = calls.filter(({ command, args }) => command === "save_text_file" && args.path === path);

    expect(result).toMatchObject({ downloaded: 51, warnings: [] });
    expect(checkpointCounts).toEqual([25, 50, 51]);
    expect(writes.map(({ args }) => JSON.parse(args.content as string).pdfs.length)).toEqual([25, 50, 51]);
    expect(writes.map(({ args }) => args.expected)).toEqual([null, writes[0].args.content, writes[1].args.content]);
    expect(files.get(path)).toBe(writes[2].args.content);
  });

  it("preserves a conflicting checkpoint and completes later batches without further cache writes or warning spam", async () => {
    snapshots.get("example-ue")!.resources = Array.from({ length: 51 }, (_, index) => ({
      ...resource, url: `${origin}/access/content/group/example-ue/${String(index).padStart(2, "0")}.pdf`,
    }));
    const path = `${cfg.basisPfad}/.mci-manager/sakai-${await sakaiHash(cfg.semester)}.json`;
    beforeInvoke = (command, args) => { if (command === "save_text_file" && args.path === path) files.set(path, "Concurrent cache change"); };

    const result = await syncSakai(cfg, [event], selections, options);

    expect(files.get(path)).toBe("Concurrent cache change");
    expect(result).toMatchObject({ updated: 1, downloaded: 51, warnings: [expect.stringContaining("Cache konnte nicht sicher gespeichert")] });
    expect(calls.filter(({ command, args }) => command === "save_text_file" && args.path === path)).toHaveLength(1);
    expect(calls.find(({ command, args }) => command === "save_text_file" && args.path === path)?.args.expected).toBeNull();
  });

  it("treats native cache symlink/read failures as unavailable and never overwrites that path", async () => {
    const path = `${cfg.basisPfad}/.mci-manager/sakai-${await sakaiHash(cfg.semester)}.json`;
    errors.set(`read_text_file:${path}`, "Native symlink access denied");

    const result = await syncSakai(cfg, [event], selections, options);

    expect(result.updated).toBe(1);
    expect(result.warnings).toEqual([expect.stringContaining("Cache ist nicht sicher lesbar")]);
    expect(calls.filter(({ command, args }) => command === "save_text_file" && args.path === path)).toEqual([]);
  });
});

describe("Sakai semester course exclusions", () => {
  it("omits excluded subject selections before warning about missing active event mappings", async () => {
    files.set(`${cfg.basisPfad}/Sem01/.mci-manager/excluded-subjects.json`, JSON.stringify({
      version: 1, subjectKeys: ["coding"], sakaiSiteIds: [],
    }));

    const result = await syncSakai(cfg, [], [...selections, generalSelection], options);

    expect(result).toMatchObject({ updated: 1, downloaded: 0, warnings: [] });
    expect(calls.filter(({ command }) => command === "sakai_site_snapshot").map(({ args }) => args.siteId)).toEqual(["example-general"]);
  });

  it.each([
    { subjectKey: "coding", events: [event] },
    { subjectKey: null, events: [] },
  ])("omits configured Sakai sites for both mapped and general selections: $subjectKey", async ({ subjectKey, events }) => {
    files.set(`${cfg.basisPfad}/Sem01/.mci-manager/excluded-subjects.json`, JSON.stringify({
      version: 1, subjectKeys: [], sakaiSiteIds: ["example-ue"],
    }));

    const result = await syncSakai(cfg, events, [{ siteId: "example-ue", subjectKey }, generalSelection], options);

    expect(result).toMatchObject({ updated: 1, downloaded: 0, warnings: [] });
    expect(calls.filter(({ command }) => command === "sakai_site_snapshot").map(({ args }) => args.siteId)).toEqual(["example-general"]);
  });

  it("preserves existing notes, PDFs and cache when every selected course is excluded", async () => {
    await syncSakai(cfg, [event], selections, options);
    files.set(`${cfg.basisPfad}/Sem01/.mci-manager/excluded-subjects.json`, JSON.stringify({
      version: 1, subjectKeys: ["coding"], sakaiSiteIds: ["example-ue"],
    }));
    const originals = [...files];
    calls = [];

    const result = await syncSakai(cfg, [], selections, options);

    expect(result).toMatchObject({ updated: 0, unchanged: 0, downloaded: 0, warnings: [] });
    expect([...files]).toEqual(originals);
    expect(calls.filter(({ command }) => command === "sakai_site_snapshot" || command === "sakai_download_pdf" || command === "save_text_file")).toEqual([]);
  });

  it("reads exclusions only from the configured semester", async () => {
    files.set(`${cfg.basisPfad}/Sem01/.mci-manager/excluded-subjects.json`, JSON.stringify({
      version: 1, subjectKeys: ["coding"], sakaiSiteIds: ["example-ue"],
    }));

    const result = await syncSakai({ ...cfg, semester: "Sem02" }, [event], selections, options);

    expect(result).toMatchObject({ updated: 1, downloaded: 1, warnings: [] });
    expect(calls.filter(({ command }) => command === "sakai_site_snapshot").map(({ args }) => args.siteId)).toEqual(["example-ue"]);
  });

  it("stops before source requests or writes when exclusions are malformed", async () => {
    files.set(`${cfg.basisPfad}/Sem01/.mci-manager/excluded-subjects.json`, "{broken");

    await expect(syncSakai(cfg, [event], selections, options)).rejects.toThrow("Fach-Ausschlussdatei");

    expect(calls.filter(({ command }) => command !== "plugin:path|join")).toEqual([
      { command: "read_text_file", args: { path: `${cfg.basisPfad}/Sem01/.mci-manager/excluded-subjects.json` } },
    ]);
  });

  it("surfaces exclusion permission errors before source requests or writes", async () => {
    errors.set(`read_text_file:${cfg.basisPfad}/Sem01/.mci-manager/excluded-subjects.json`, new Error("Permission denied"));

    await expect(syncSakai(cfg, [event], selections, options)).rejects.toThrow("Permission denied");

    expect(calls.filter(({ command }) => command !== "plugin:path|join")).toEqual([
      { command: "read_text_file", args: { path: `${cfg.basisPfad}/Sem01/.mci-manager/excluded-subjects.json` } },
    ]);
  });
});

describe("Sakai cancellation and session boundaries", () => {
  it("does no IPC when the configuration is already obsolete", async () => {
    current = false;

    await expect(syncSakai(cfg, [event], selections, options)).rejects.toThrow("SAKAI_CANCELLED");
    expect(calls).toEqual([]);
  });

  it.each(["plugin:path|join", "read_text_file", "list_docs", "sakai_site_snapshot", "sakai_download_pdf", "ensure_dir"])("stops after a stale response from %s without subsequent writes", async (boundary) => {
    beforeInvoke = (command) => { if (command === boundary) current = false; };

    await expect(syncSakai(cfg, [event], selections, options)).rejects.toThrow("SAKAI_CANCELLED");

    expect(calls.at(-1)?.command).toBe(boundary);
    expect(calls.filter(({ command }) => command === "save_text_file")).toEqual([]);
  });

  it("checks cancellation after progress callbacks before requesting a source", async () => {
    options.onProgress.mockImplementation(() => { current = false; });

    await expect(syncSakai(cfg, [event], selections, options)).rejects.toThrow("SAKAI_CANCELLED");
    expect(calls.filter(({ command }) => command === "sakai_site_snapshot" || command === "save_text_file")).toEqual([]);
  });

  it("keeps the completed checkpoint when cancelled by progress before the next batch download", async () => {
    snapshots.get("example-ue")!.resources = Array.from({ length: 26 }, (_, index) => ({
      ...resource, url: `${origin}/access/content/group/example-ue/${String(index).padStart(2, "0")}.pdf`,
    }));
    const path = `${cfg.basisPfad}/.mci-manager/sakai-${await sakaiHash(cfg.semester)}.json`;
    options.onProgress.mockImplementation(() => {
      if (calls.filter(({ command }) => command === "sakai_download_pdf").length === 25) current = false;
    });

    await expect(syncSakai(cfg, [event], selections, options)).rejects.toThrow("SAKAI_CANCELLED");

    expect(calls.filter(({ command }) => command === "sakai_download_pdf")).toHaveLength(25);
    expect(calls.at(-1)).toMatchObject({ command: "save_text_file", args: { path } });
    expect(JSON.parse(files.get(path)!).pdfs).toHaveLength(25);
    expect([...files.keys()].filter((path) => path.endsWith(".md"))).toEqual([]);
  });

  it("stops after a stale checkpoint response without starting another batch", async () => {
    snapshots.get("example-ue")!.resources = Array.from({ length: 26 }, (_, index) => ({
      ...resource, url: `${origin}/access/content/group/example-ue/${String(index).padStart(2, "0")}.pdf`,
    }));
    const path = `${cfg.basisPfad}/.mci-manager/sakai-${await sakaiHash(cfg.semester)}.json`;
    beforeInvoke = (command, args) => { if (command === "save_text_file" && args.path === path) current = false; };

    await expect(syncSakai(cfg, [event], selections, options)).rejects.toThrow("SAKAI_CANCELLED");

    expect(calls.filter(({ command }) => command === "sakai_download_pdf")).toHaveLength(25);
    expect(calls.at(-1)).toMatchObject({ command: "save_text_file", args: { path } });
    expect(JSON.parse(files.get(path)!).pdfs).toHaveLength(25);
  });

  it.each([
    ["sakai_site_snapshot:example-ue", "SAKAI_AUTH_REQUIRED"],
    ["sakai_site_snapshot:example-ue", "SAKAI_CANCELLED"],
    [`sakai_download_pdf:${resource.url}`, "SAKAI_AUTH_REQUIRED"],
    [`sakai_download_pdf:${resource.url}`, "SAKAI_CANCELLED"],
  ])("propagates exact session errors from %s", async (key, code) => {
    errors.set(key, code);

    await expect(syncSakai(cfg, [event], selections, options)).rejects.toThrow(code);
    expect(calls.filter(({ command }) => command === "save_text_file")).toEqual([]);
  });
});
