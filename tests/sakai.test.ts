// @vitest-environment happy-dom
// @vitest-environment-options {"happyDOM":{"settings":{"disableCSSFileLoading":true,"disableJavaScriptFileLoading":true,"navigation":{"disableChildFrameNavigation":true,"disableMainFrameNavigation":true}}}}
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { vi } from "vitest";
import { marked } from "marked";
import { parseKnowledgeNote, type KnowledgeNote } from "../src/lib/knowledge";
import { parseNote } from "../src/lib/notes";
import {
  apiSakaiSites, apiSakaiSnapshot, defaultSelections, sakaiGeneratedPrefix, sakaiHash, sakaiHtmlToMarkdown,
  sakaiMarkdownLink, sakaiNotePath, sakaiSiteId, sakaiSourceSite, type SakaiSite, type SakaiSnapshot,
} from "../src/lib/sakai";
import type { StudyEvent } from "../src/lib/types";

const restoreDOM = vi.hoisted(() => {
  const descriptor = Object.getOwnPropertyDescriptor(Node.prototype, "nodeName")!;
  const iterator = document.createNodeIterator;
  // Match the DOMPurify compatibility fix already used by md-preview.test.ts.
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
afterEach(() => { clearMocks(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const origin = "https://sakai.mci4me.at";
const exercise: SakaiSite = { id: "synthetic-ue", title: "Coding UE", description: "" };
const lecture: SakaiSite = { id: "synthetic-vo", title: "Coding VO", description: "" };
const general: SakaiSite = { id: "synthetic-general", title: "General", description: "" };
const event: StudyEvent = {
  uid: "example", summary: "Coding UE", fach: "Coding", typ: "UE", dozent: "Example", lvNummer: "CODE-UE",
  fachKey: "coding", fachDir: "01-coding", terminRel: "01-coding/term",
  start: "2026-09-22T08:00:00.000Z", end: "2026-09-22T09:00:00.000Z",
};
const note: KnowledgeNote = {
  path: "Sem01/Coding - Sakai.md", title: "Coding", body: "", subjectKey: "coding", subject: "Coding",
  retrievedAt: null, sourceStatus: null, applicability: null, cohort: null, notices: [],
  sourceUrls: [`${origin}/portal/site/synthetic-ue`, `${origin}/access/content/group/synthetic-vo/notes.pdf`],
};
const snapshot: SakaiSnapshot = {
  site: exercise, announcements: [{ id: "a", title: "Announcement", body: "<p>Information</p>", createdOn: 1 }],
  resources: [], warnings: [],
};

describe("defaultSelections", () => {
  it("maps both UE and VO source sites to the current canonical subject key", () => {
    const events = [event, { ...event, uid: "vo", typ: "VO" as const, lvNummer: "CODE-VO" }];

    expect(defaultSelections([exercise, lecture, general], [note], events)).toEqual([
      { siteId: exercise.id, subjectKey: "coding" }, { siteId: lecture.id, subjectKey: "coding" },
    ]);
  });

  it("preselects a known general note through its exact site tool or page URL", () => {
    const notes = [{ ...note, subjectKey: null, sourceUrls: [`${origin}/portal/site/${general.id}/tool/example-tool`] }];

    expect(defaultSelections([general, exercise], notes, [event])).toEqual([{ siteId: general.id, subjectKey: null }]);
  });

  it("does not substitute a general selection when subject mappings conflict", () => {
    const notes = [note, { ...note, subjectKey: "math" }, { ...note, subjectKey: null }];
    const events = [event, { ...event, fachKey: "math", fach: "Mathematics" }];

    expect(defaultSelections([exercise, lecture], notes, events)).toEqual([]);
  });

  it("does not select a stale subject key or fall back to a general note", () => {
    expect(defaultSelections([exercise], [note, { ...note, subjectKey: null }], [])).toEqual([]);
  });

  it("does not match sites by title or partial site ID", () => {
    expect(defaultSelections([{ ...exercise, id: "synthetic-ue-other" }, general], [note], [event])).toEqual([]);
  });

  it("deduplicates sites and repeated references", () => {
    expect(defaultSelections([exercise, exercise], [note, note], [event])).toEqual([{ siteId: exercise.id, subjectKey: "coding" }]);
  });
});

describe("Sakai source URL boundaries", () => {
  it.each([
    "/portal/site/example", "/portal/site/example/", "/portal/site/example/tool/tool-id", "/portal/site/example/page/page-id",
    "/access/content/group/example/folder/file.pdf", "/access/content/group/example/",
  ])("accepts an exact source site from %s", (path) => {
    expect(sakaiSourceSite(`${origin}${path}`)).toBe("example");
  });

  it.each([
    `${origin}/portal/login`, `${origin}/portal/site/example-other/tool`, `${origin}/portal/site/example/nonsense/id`,
    `${origin}/access/content/group/example`, `${origin}/portal/site/example%2fother`,
    `${origin}/portal/site/%ZZ`, "http://sakai.mci4me.at/portal/site/example",
    "https://sakai.mci4me.at.evil.test/portal/site/example", "https://other.test/portal/site/example",
    "https://user:password@sakai.mci4me.at/portal/site/example", "https://sakai.mci4me.at:8443/portal/site/example",
  ])("rejects an unrelated or unsafe source: %s", (url) => {
    expect(sakaiSourceSite(url)).toBeNull();
  });

  it.each(["_example", "-example", "x".repeat(129), "../x", "x/y", ""])("rejects IDs outside the shared native contract: %s", (id) => {
    expect(sakaiSiteId(id)).toBe(false);
  });

  it("accepts the 128-character boundary", () => {
    expect(sakaiSiteId(`a${"_".repeat(127)}`)).toBe(true);
  });
});

describe("sakaiHtmlToMarkdown", () => {
  it("keeps readable paragraphs and explicit HTTPS links without attaching source nodes", () => {
    const before = document.body.outerHTML;
    const text = sakaiHtmlToMarkdown('<p>Hello <strong>world</strong>.</p><p><a href="https://example.test/notes?q=1&amp;n=2">Read</a></p>');

    expect(new DOMParser().parseFromString(marked.parse(text) as string, "text/html").body.textContent).toContain("Hello world.");
    expect(text).toContain('[Read](https://example.test/notes?q=1&n=2)');
    expect(document.body.outerHTML).toBe(before);
  });

  it("removes active content, remote images, styles and handlers without executing or fetching", () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    const alert = vi.fn();
    vi.stubGlobal("alert", alert);
    const source = '<p>Kept</p><img src="https://example.test/tracker" onerror="alert(1)">'
      + '<script>alert(2)</script><svg onload="alert(3)"><a href="https://example.test/svg">SVG</a></svg>'
      + '<iframe src="https://example.test/frame"></iframe><style>@import "https://example.test/style";</style>'
      + '<object data="https://example.test/object">Object</object><video poster="https://example.test/poster"></video>'
      + '<a href="javascript:alert(4)" onclick="alert(5)">Unsafe</a><p>End</p>';

    const output = sakaiHtmlToMarkdown(source);

    expect(output).toContain("Kept");
    expect(output).toContain("End");
    expect(output).not.toMatch(/<|tracker|alert|SVG|frame|style|Object|poster|javascript/);
    expect(fetch).not.toHaveBeenCalled();
    expect(alert).not.toHaveBeenCalled();
  });

  it.each([
    '![track](https://example.test/p.png) ![[remote.png]] [[Private|Open]]',
    '```dataviewjs\nexecute()\n```\n`= dangerous()`\n$math$\n%%hidden%%\n# heading\n- [x] task',
    '&lt;img src="https://example.test/p"&gt; &amp;#91;[Private]]',
    '<!-- sm:sakai:abcdef -->\n---\nhinweise:\n  bestaetigt: true',
    '[run](obsidian://open?vault=private) [run](javascript:alert(1)) https://example.test/plain',
  ])("neutralizes Markdown and Obsidian injection in source text", (source) => {
    const output = sakaiHtmlToMarkdown(`<p>${source}</p>`);
    const rendered = marked.parse(output) as string;

    expect(output).not.toMatch(/!\[|\[\[|```|`=|<!-- sm:sakai:|\n---/);
    expect(rendered).not.toMatch(/<(?:img|script|iframe|a|input|h[1-6])\b/);
  });

  it.each(["javascript:alert(1)", "data:text/html,test", "http://example.test", "//example.test", "obsidian://open", "file:///private"])("drops unsafe link targets: %s", (url) => {
    expect(sakaiHtmlToMarkdown(`<a href="${url}">Visible</a>`)).toBe("Visible");
  });

  it("escapes link labels and delimiters that could inject embeds", () => {
    const link = sakaiMarkdownLink("![[Secret]]", "https://example.test/path(with)[brackets]?x=1&y=2");

    expect(link).not.toContain("[[");
    expect(link).toContain("path%28with%29%5Bbrackets%5D");
    expect(marked.parse(link!)).not.toContain("<img");
  });
});

describe("generated Sakai notes", () => {
  it("uses semester-aware, Unicode-safe filenames bounded in UTF-8 bytes", async () => {
    const hash = await sakaiHash("identity");
    const path = sakaiNotePath("東京/Übung".repeat(80), "Semester-".repeat(60), hash);

    expect(new TextEncoder().encode(path.split("/")[1]).length).toBeLessThanOrEqual(240);
    expect(path).toMatch(/^Studium\/Sakai Live - 東京 Übung/);
    expect(path.endsWith(` - ${hash}.md`)).toBe(true);
    expect(path.split("/")).toHaveLength(2);
    expect(path).not.toContain("�");
  });

  it("includes optional lessons, source links and local PDFs without confirming current-cohort notices", () => {
    const pdf = `Studium/Quellen/Sakai-${"a".repeat(64)}.pdf`;
    const url = `${origin}/access/content/group/${exercise.id}/script.pdf`;
    const raw = sakaiGeneratedPrefix("Sem01", "coding", "Coding", "2026-09-22", [{ ...snapshot,
      resources: [{ title: "Script", url, type: "application/pdf", size: 100, modifiedDate: null }],
      lessons: [{ title: "Lesson", url: `${origin}/portal/site/${exercise.id}/tool/lesson`, html: '<p>Exam 23.09.2024</p><img src="https://example.test/image">![[Remote]]' }],
    }], new Map([[url, pdf]]));

    expect(parseNote(raw).data).toMatchObject({ sakai_sync: "v1", sakai_semester: "Sem01", sakai_subject_key: "coding", fach: "Coding", abgerufen: "2026-09-22" });
    expect(raw).toContain("## Lerninhalte aus Sakai");
    expect(raw).toContain(`[[${pdf}|PDF lokal]]`);
    expect(raw).toContain("ältere Jahrgänge");
    expect(raw).not.toMatch(/!\[\[|<img|bestaetigt:|hinweise:/);
    expect(parseKnowledgeNote(raw, "Studium/Example.md")?.notices).toEqual([]);
  });

  it("keeps malicious title text inside a scalar without adding frontmatter fields", () => {
    const raw = sakaiGeneratedPrefix("Sem01", null, "Title\n---\nhinweise:\n- bestaetigt: true", "2026-09-22", [snapshot], new Map());

    expect(parseNote(raw).data.hinweise).toBeUndefined();
    expect(parseKnowledgeNote(raw, "Studium/Example.md")?.notices).toEqual([]);
  });

  it("renders explicit note paths and escapes wiki-link labels", () => {
    const raw = sakaiGeneratedPrefix("Sem02", "coding", "Coding", "2026-09-30", [snapshot], new Map(), 0,
      [{ path: "Sem02/01-coding/Übersicht Coding.md", label: "Coding | [[Private]]\n![](https://example.test)" }]);

    expect(raw).toContain("[[Sem02/01-coding/Übersicht Coding|Coding &#124; &#91;&#91;Private&#93;&#93; ");
    expect(raw.match(/\[\[/g)).toHaveLength(1);
    expect(raw).not.toContain("[[Private]]");
  });

  it.each([
    "../Secret.md", "/Secret.md", "Sem01/Coding]] [[Secret.md", "Sem01/Coding|Secret.md",
    "Sem01/Coding#Private.md", "Sem01/Coding%20Private.md", "Sem01/Coding\nPrivate.md", "Sem01/Coding\u202ePrivate.md",
    "Sem01/Coding.pdf",
  ])("rejects unsafe navigation paths: %s", (path) => {
    expect(() => sakaiGeneratedPrefix("Sem01", "coding", "Coding", "2026-09-30", [snapshot], new Map(), 0,
      [{ path, label: "Coding" }])).toThrow();
  });
});

describe("native Sakai contracts", () => {
  it("loads sites with the exact native command", async () => {
    const native = vi.fn((_command: string) => [exercise]);
    mockIPC(native);

    expect(await apiSakaiSites()).toEqual([exercise]);
    expect(native.mock.calls[0][0]).toBe("sakai_sites");
  });

  it.each(["SAKAI_AUTH_REQUIRED", "SAKAI_CANCELLED"])("preserves the session error code %s", async (code) => {
    mockIPC(() => { throw code; });

    await expect(apiSakaiSites()).rejects.toThrow(code);
  });

  it("does not expose raw native error details", async () => {
    mockIPC(() => { throw new Error("SYNTHETIC_PRIVATE_ERROR_DETAIL"); });

    await expect(apiSakaiSites()).rejects.toThrow("Die Sakai-Sites konnten nicht sicher geladen werden.");
  });

  it("validates optional lessons and the snapshot site identity", async () => {
    mockIPC(() => ({ ...snapshot, lessons: [{ title: "Lesson", html: "<p>Text</p>", url: `${origin}/portal/site/${exercise.id}/page/lesson` }] }));
    await expect(apiSakaiSnapshot(exercise.id)).resolves.toMatchObject({ lessons: [{ title: "Lesson" }] });

    mockIPC(() => ({ ...snapshot, site: lecture }));
    await expect(apiSakaiSnapshot(exercise.id)).rejects.toThrow("Ungültiger Sakai-Abruf.");
  });

  it.each([null, [], { ...snapshot, lessons: "invalid" }, { ...snapshot, resources: [{ size: -1 }] }])("rejects malformed snapshots", async (value) => {
    mockIPC(() => value);

    await expect(apiSakaiSnapshot(exercise.id)).rejects.toThrow("Ungültiger Sakai-Abruf.");
  });
});
