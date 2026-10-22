// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SubjectKnowledge } from "../src/components/KnowledgeHighlights";
import type { KnowledgeNote } from "../src/lib/knowledge";
import type { AppConfig } from "../src/lib/types";

const native = vi.hoisted(() => ({ invoke: vi.fn(), join: vi.fn(), openUrl: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));
vi.mock("@tauri-apps/api/path", () => ({ join: native.join }));
vi.mock("../src/lib/storage", () => ({ apiOpenExternalUrl: native.openUrl }));

const restoreDOM = vi.hoisted(() => {
  const nodeName = Object.getOwnPropertyDescriptor(Node.prototype, "nodeName")!;
  const createNodeIterator = document.createNodeIterator;
  const iteratorDescriptor = Object.getOwnPropertyDescriptor(document, "createNodeIterator");
  Object.defineProperty(Node.prototype, "nodeName", {
    ...nodeName,
    get(this: Node): string {
      let prototype = Object.getPrototypeOf(this);
      while (prototype && prototype !== Node.prototype) {
        const getter = Object.getOwnPropertyDescriptor(prototype, "nodeName")?.get;
        if (getter) return getter.call(this);
        prototype = Object.getPrototypeOf(prototype);
      }
      return nodeName.get!.call(this);
    },
  });
  document.createNodeIterator = function (...args) {
    const iterator = createNodeIterator.apply(this, args);
    const nodes: Node[] = [];
    let node: Node | null;
    while ((node = iterator.nextNode())) nodes.push(node);
    let index = 0;
    iterator.nextNode = () => nodes[index++] ?? null;
    return iterator;
  };
  return () => {
    Object.defineProperty(Node.prototype, "nodeName", nodeName);
    if (iteratorDescriptor) Object.defineProperty(document, "createNodeIterator", iteratorDescriptor);
    else Reflect.deleteProperty(document, "createNodeIterator");
  };
});
afterAll(restoreDOM);

const summary: KnowledgeNote = {
  path: "Sem01/07-coding/Coding - Sakai.md",
  title: "Coding: Grundlagen, Übungen und Prüfungsvorbereitung",
  body: "", subjectKey: "coding", subject: "Coding", retrievedAt: null,
  sourceStatus: null, applicability: null, cohort: null, sourceUrls: [], notices: [],
};
const live: KnowledgeNote = {
  ...summary, path: "Sem01/07-coding/Coding - Sakai Live.md", title: "Sakai Live: Coding – Unterlagen für UE und VO",
  isSakaiLive: true, retrievedAt: "2026-09-30",
  body: "# Sakai Live: Coding\n\n## Quellenübersicht\n\nWillkommen im Kurs. Bitte die Einführung lesen.\n\n"
    + "## Ankündigungen der letzten 365 Tage\n\nDie Präsentation ist online.\n\n"
    + "## Lerninhalte aus Sakai\n\n### Erste Einheit\n\nZusätzliche Lerninhalte.\n\n"
    + "## Ressourcen\n\n### Coding\n\n- [Einführung.pdf](https://sakai.example/course/intro.pdf) · [[docs/intro.pdf|PDF lokal]]\n"
    + "- [Folien.pptx](https://sakai.example/course/slides.pptx)\n\n"
    + "<!-- sm:sakai:abc -->\n\n## Persönliche Notizen\n\nPrivate Gedanken.\n",
};
const additional: KnowledgeNote = {
  ...summary, path: "Sem01/07-coding/Weitere Unterlagen.md", title: "Weitere Unterlagen zu Coding",
};
const other: KnowledgeNote = {
  ...summary, path: "Sem01/08-networks/Networks - Sakai.md", title: "Networks", subjectKey: "networks", subject: "Networks",
};
const general: KnowledgeNote = {
  ...summary, path: "Studium/General.md", title: "Allgemeines Studienwissen", subjectKey: null, subject: null,
};
const notes = [summary, other, live, general, additional];
const onOpen = vi.fn();
const cfg: AppConfig = { basisPfad: "/vault", semester: "Sem01", icalUrl: "https://example.test/calendar", refreshHours: 12, lastRefresh: null };
const sakai = {
  connected: true, busy: false, progress: "", error: null, report: null,
  preferences: { autoSync: true, lastSync: null, selections: [{ siteId: "course", subjectKey: "coding" }] },
  run: vi.fn().mockResolvedValue(undefined), beginLogin: vi.fn().mockResolvedValue(undefined),
};
let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.resetAllMocks();
  native.invoke.mockResolvedValue(undefined);
  native.join.mockImplementation(async (...parts: string[]) => parts.join("/"));
  native.openUrl.mockResolvedValue(undefined);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("SubjectKnowledge", () => {
  it("shows current Sakai materials before every matching manual note", async () => {
    await act(async () => root.render(createElement(SubjectKnowledge, { notes, subjectKey: "coding", onOpen })));

    expect([...container.querySelectorAll("button strong")].map((title) => title.textContent))
      .toEqual([live.title, summary.title, additional.title]);
  });

  it("distinguishes manual summaries from Sakai Live while preserving full titles", async () => {
    await act(async () => root.render(createElement(SubjectKnowledge, { notes: [summary, live], subjectKey: "coding", onOpen })));

    expect([...container.querySelectorAll("button")].map((card) => ({
      category: card.querySelector("small")?.textContent,
      title: card.querySelector("strong")?.textContent,
      metadata: card.querySelector(".subject-knowledge-copy > span")?.textContent,
    }))).toEqual([
      { category: "Sakai Live", title: live.title, metadata: "Zuletzt abgerufen am 30.9.2026 · Gesamte Notiz öffnen" },
      { category: "Fachnotiz", title: summary.title, metadata: "Notiz öffnen" },
    ]);
  });

  it("groups course notes and materials in a named section across all classes", async () => {
    await act(async () => root.render(createElement(SubjectKnowledge, { notes, subjectKey: "coding", onOpen })));

    expect(container.querySelector('section[aria-label="Unterlagen zum Fach"]')).not.toBeNull();
    expect(container.querySelector(".knowledge-subject-heading h3")?.textContent).toBe("Wissen & Unterlagen zum Fach");
    expect(container.textContent?.match(/Sakai-Informationen, Materialien und Notizen für alle Einheiten\./g)).toHaveLength(1);
    expect(container.querySelectorAll("ul.subject-knowledge-grid > li > button[type=button]"))
      .toHaveLength(2);
    expect(container.querySelectorAll(".subject-knowledge-card")).toHaveLength(3);
  });

  it("keeps document and chevron icons decorative", async () => {
    await act(async () => root.render(createElement(SubjectKnowledge, { notes: [summary], subjectKey: "coding", onOpen })));

    expect(container.querySelector(".subject-knowledge-icon svg")?.getAttribute("aria-hidden")).toBe("true");
    expect(container.querySelector("button > svg:last-child")?.getAttribute("aria-hidden")).toBe("true");
    expect(container.querySelectorAll('svg:not([aria-hidden="true"])')).toHaveLength(0);
  });

  it("opens each note through its unchanged path", async () => {
    await act(async () => root.render(createElement(SubjectKnowledge, { notes, subjectKey: "coding", onOpen })));
    const cards = container.querySelectorAll<HTMLButtonElement>("button");

    expect(onOpen).not.toHaveBeenCalled();
    await act(async () => cards[0].click());
    await act(async () => cards[1].click());
    await act(async () => cards[2].click());

    expect(onOpen.mock.calls).toEqual([[live.path], [summary.path], [additional.path]]);
  });

  it("shows resource links directly and keeps the full introduction collapsed", async () => {
    await act(async () => root.render(createElement(SubjectKnowledge, { notes, subjectKey: "coding", onOpen })));

    const resources = container.querySelector(".sakai-course-resources")!;
    expect([...resources.querySelectorAll("a")].map((link) => link.textContent)).toEqual(["Einführung.pdf", "PDF lokal", "Folien.pptx"]);
    expect(resources.closest("details")).toBeNull();
    const details = container.querySelector<HTMLDetailsElement>("details")!;
    expect(details.querySelector("summary")?.textContent).toBe("Einführung & Kursinformationen");
    expect(details.open).toBe(false);
    expect(details.textContent).toContain("Willkommen im Kurs. Bitte die Einführung lesen.");
    expect(resources.textContent).not.toContain("Willkommen");
    expect(container.textContent).not.toContain("Private Gedanken");
  });

  it("uses the newest Live note and keeps older imported notes selectable", async () => {
    const older = { ...live, path: "Sem01/07-coding/Older.md", retrievedAt: "2026-09-29", title: "Sakai Live: Älterer Abruf" };
    await act(async () => root.render(createElement(SubjectKnowledge, { notes: [summary, older, live], subjectKey: "coding", onOpen })));

    expect([...container.querySelectorAll("button strong")].map((title) => title.textContent)).toEqual([live.title, older.title, summary.title]);
    expect(container.querySelector(".subject-knowledge-grid small")?.textContent).toBe("Weiterer Sakai-Abruf");
  });

  it("preserves source and applicability context alongside the retrieval date", async () => {
    const scoped = { ...live, sourceStatus: "Automatischer Sakai-Abruf", applicability: "Kommunikation, UE und VO" };
    await act(async () => root.render(createElement(SubjectKnowledge, { notes: [scoped], subjectKey: "coding", onOpen })));

    expect(container.textContent).toContain("Quellenstand: Automatischer Sakai-Abruf.");
    expect(container.textContent).toContain("Die Geltung für den aktuellen Jahrgang ist nicht bestätigt.");
    expect(container.textContent).toContain("Geltung: Kommunikation, UE und VO");
  });

  it.each([false, undefined])("does not interpret a manual note as a generated Sakai import when isSakaiLive is %s", async (isSakaiLive) => {
    const manual = { ...live, isSakaiLive };
    await act(async () => root.render(createElement(SubjectKnowledge, { notes: [manual], subjectKey: "coding", onOpen })));

    expect(container.querySelector(".sakai-course-materials")).toBeNull();
    expect(container.querySelector("small")?.textContent).toBe("Fachnotiz");
  });

  it("opens PDFs locally and source presentations through the existing safe APIs", async () => {
    await act(async () => root.render(createElement(SubjectKnowledge, { notes, subjectKey: "coding", onOpen, cfg })));
    await act(async () => container.querySelector<HTMLAnchorElement>('[data-wiki="docs/intro.pdf"]')!.click());
    await act(async () => container.querySelector<HTMLAnchorElement>('a[href$="slides.pptx"]')!.click());

    expect(native.join).toHaveBeenCalledWith("/vault", "Sem01/07-coding/docs/intro.pdf");
    expect(native.invoke).toHaveBeenCalledWith("open_knowledge_file", { path: "/vault/Sem01/07-coding/docs/intro.pdf" });
    expect(native.openUrl).toHaveBeenCalledWith("https://sakai.example/course/slides.pptx");
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("reports opening failures without leaving the course", async () => {
    native.openUrl.mockRejectedValueOnce(new Error("Offline"));
    native.invoke.mockRejectedValueOnce(new Error("Missing file"));
    await act(async () => root.render(createElement(SubjectKnowledge, { notes, subjectKey: "coding", onOpen, cfg })));
    await act(async () => container.querySelector<HTMLAnchorElement>('a[href$="slides.pptx"]')!.click());
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Weblink konnte nicht geöffnet werden.");
    await act(async () => container.querySelector<HTMLAnchorElement>('[data-wiki="docs/intro.pdf"]')!.click());
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Verknüpfte Datei konnte nicht geöffnet werden.");
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("blocks unsafe local paths and sanitizes rendered imported HTML", async () => {
    const unsafe = { ...live, body: "## Ressourcen\n\n[[../../secret.pdf|Bad path]]\n\n<script>alert(1)</script><img src=x onerror=alert(1)>" };
    await act(async () => root.render(createElement(SubjectKnowledge, { notes: [unsafe], subjectKey: "coding", onOpen, cfg })));
    await act(async () => container.querySelector<HTMLAnchorElement>("[data-wiki]")!.click());

    expect(native.invoke).not.toHaveBeenCalled();
    expect(native.join).not.toHaveBeenCalled();
    expect(container.querySelector("script, [onerror]")).toBeNull();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Verknüpfte Datei konnte nicht geöffnet werden.");
  });

  it("refreshes the active subject and displays loading and failed sync states", async () => {
    await act(async () => root.render(createElement(SubjectKnowledge, { notes, subjectKey: "coding", onOpen, cfg, sakai })));
    const button = container.querySelector<HTMLButtonElement>(".sakai-course-toolbar button")!;
    expect(button.textContent).toContain("Sakai aktualisieren");
    await act(async () => button.click());
    expect(sakai.run).toHaveBeenCalledWith("coding");

    await act(async () => root.render(createElement(SubjectKnowledge, { notes, subjectKey: "coding", onOpen, cfg, sakai: { ...sakai, busy: true, progress: "PDFs werden geladen …" } })));
    expect(button.disabled).toBe(true);
    expect(container.querySelector('[role="status"]')?.textContent).toBe("PDFs werden geladen …");
    await act(async () => root.render(createElement(SubjectKnowledge, { notes, subjectKey: "coding", onOpen, cfg, sakai: { ...sakai, error: "Abruf fehlgeschlagen." } })));
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Abruf fehlgeschlagen.");
    expect(container.querySelectorAll(".sakai-course-resources a")).toHaveLength(3);
  });

  it("offers login when disconnected and explains missing course mappings", async () => {
    await act(async () => root.render(createElement(SubjectKnowledge, { notes: [], subjectKey: "coding", onOpen, sakai: { ...sakai, connected: false } })));
    const buttons = container.querySelectorAll<HTMLButtonElement>(".sakai-course-toolbar button");
    expect(buttons[0].disabled).toBe(true);
    expect(container.textContent).toContain("Sakai ist nicht verbunden.");
    expect(container.textContent).toContain("Für dieses Fach liegt noch kein Sakai-Abruf vor.");
    await act(async () => buttons[1].click());
    expect(sakai.beginLogin).toHaveBeenCalledOnce();

    await act(async () => root.render(createElement(SubjectKnowledge, { notes: [], subjectKey: "coding", onOpen, sakai: { ...sakai, preferences: { ...sakai.preferences, selections: [] } } })));
    expect(container.querySelector<HTMLButtonElement>(".sakai-course-toolbar button")?.disabled).toBe(true);
    expect(container.textContent).toContain("Für dieses Fach ist noch kein Sakai-Kurs zugeordnet.");
  });

  it("shows partial sync warnings without presenting the previous note as a new retrieval", async () => {
    const report = { updated: 0, unchanged: 0, downloaded: 0, warnings: ["Coding: Der Kurs konnte nicht abgerufen werden."], failedSubjectKeys: ["coding"], completedAt: "2026-10-01T10:00:00Z" };
    await act(async () => root.render(createElement(SubjectKnowledge, { notes, subjectKey: "coding", onOpen, sakai: { ...sakai, report } })));

    expect(container.querySelector(".sakai-course-toolbar h4")?.textContent).toBe("Sakai-Unterlagen");
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Aktualisierung für dieses Fach fehlgeschlagen. Angezeigt wird der letzte gespeicherte Stand.");
    expect(container.querySelector("details.banner-info summary")?.textContent).toBe("Hinweise zum letzten Sakai-Abruf (1)");
    expect(container.querySelector("details.banner-info")?.textContent).toContain("Coding: Der Kurs konnte nicht abgerufen werden.");
    expect(container.querySelector<HTMLDetailsElement>("details.banner-info")?.open).toBe(true);
    expect(container.querySelector(".sakai-course-note")?.textContent).toContain("Zuletzt abgerufen am 30.9.2026");
    expect(container.querySelector(".sakai-course-note")?.textContent).not.toContain("1.10.2026");
    expect(container.querySelectorAll(".sakai-course-resources a")).toHaveLength(3);
  });

  it("reports failed first imports without claiming a stored course version exists", async () => {
    const report = { updated: 0, unchanged: 0, downloaded: 0, warnings: ["Coding: Der Kurs konnte nicht abgerufen werden."], failedSubjectKeys: ["coding"], completedAt: "2026-10-01T10:00:00Z" };
    await act(async () => root.render(createElement(SubjectKnowledge, { notes: [], subjectKey: "coding", onOpen, sakai: { ...sakai, report } })));

    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Aktualisierung für dieses Fach fehlgeschlagen. Es liegt noch kein gespeicherter Stand vor.");
    expect(container.querySelector<HTMLDetailsElement>("details.banner-info")?.open).toBe(true);
    expect(container.querySelector(".sakai-course-note")).toBeNull();
  });

  it.each([{ failedSubjectKeys: ["networks"] }, { failedSubjectKeys: [] }, { failedSubjectKeys: undefined }])("does not mark a course stale for unrelated or unassigned failures: %j", async ({ failedSubjectKeys }) => {
    const report = { updated: 1, unchanged: 0, downloaded: 0, warnings: ["Ein anderer Kurs konnte nicht abgerufen werden."], failedSubjectKeys, completedAt: "2026-10-01T10:00:00Z" };
    await act(async () => root.render(createElement(SubjectKnowledge, { notes, subjectKey: "coding", onOpen, sakai: { ...sakai, report } })));

    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelector<HTMLDetailsElement>("details.banner-info")?.open).toBe(false);
    expect(container.querySelectorAll(".sakai-course-resources a")).toHaveLength(3);
  });

  it.each([{ subjectNotes: [] }, { subjectNotes: [other, general] }])("renders nothing without matching subject notes: %j", async ({ subjectNotes }) => {
    await act(async () => root.render(createElement(SubjectKnowledge, { notes: subjectNotes, subjectKey: "coding", onOpen })));

    expect(container.childNodes).toHaveLength(0);
  });
});
