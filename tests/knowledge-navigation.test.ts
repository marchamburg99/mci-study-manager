// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KnowledgeNote } from "../src/lib/knowledge";
import type { AppConfig, StudyEvent } from "../src/lib/types";

const source = vi.hoisted(() => ({ cfg: {} as AppConfig, events: [] as StudyEvent[], notes: [] as KnowledgeNote[], rawNotes: {} as Record<string, string>, refreshSubject: vi.fn() }));
const native = vi.hoisted(() => ({ invoke: vi.fn(), join: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke, isTauri: () => false }));
vi.mock("@tauri-apps/api/path", () => ({ join: native.join }));
vi.mock("../src/hooks/useStudyCalendar", () => ({ useStudyCalendar: () => ({
  cfg: source.cfg, events: source.events, syncing: false, ready: true, desktop: true, error: null, state: "synced",
  refreshNow: vi.fn(), applyConfig: vi.fn(),
}) }));
vi.mock("../src/hooks/useKnowledge", () => ({ useKnowledge: () => ({
  notes: source.notes, warnings: [], loading: false, reload: vi.fn(),
}) }));
vi.mock("../src/hooks/useSakai", () => ({ useSakai: () => ({
  connected: false, busy: false, progress: "", error: null, sites: [], rememberSession: false,
  preferences: { autoSync: false, selections: [], lastSync: null }, refreshSubject: source.refreshSubject, beginLogin: vi.fn(),
}) }));

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

import App from "../src/App";

afterAll(restoreDOM);

const note: KnowledgeNote = {
  path: "Sem01/01-coding/Coding - Sakai.md", title: "Coding Grundlagen", body: "# Coding Grundlagen\n\n[[Sem01/01-coding/Weitere.md|Weitere Unterlagen]]",
  subjectKey: "coding", subject: "Coding", retrievedAt: null, sourceStatus: null, applicability: null,
  cohort: null, sourceUrls: [], notices: [{
    id: "notice", title: "Coding Abgabe", at: "2026-09-29T10:00:00.000Z", kind: "frist", sourceUrl: "https://example.test/notice",
  }],
};
const otherNote: KnowledgeNote = {
  ...note, path: "Sem01/01-coding/Weitere.md", title: "Weitere Unterlagen", body: "# Weitere Unterlagen", notices: [],
};
const event: StudyEvent = {
  uid: "coding", summary: "Coding", fach: "Coding", typ: "ILV", dozent: "Teacher", lvNummer: "COD1",
  fachKey: "coding", fachDir: "01-coding", terminRel: "01-coding/one",
  start: "2026-09-29T07:00:00.000Z", end: "2026-09-29T08:00:00.000Z",
};
let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-09-28T10:00:00.000Z"));
  localStorage.clear();
  source.cfg = { basisPfad: "/mock", semester: "Sem01", icalUrl: "https://example.test/calendar", refreshHours: 12, lastRefresh: null };
  source.events = [event];
  source.notes = [note, otherNote];
  source.rawNotes = {};
  source.refreshSubject.mockClear();
  native.invoke.mockReset().mockImplementation(async (command: string, args?: { path: string }) => {
    if (command === "list_docs") return [];
    if (command === "read_text_file" && args) return source.rawNotes[args.path] ?? null;
    return null;
  });
  native.join.mockReset().mockImplementation(async (...parts: string[]) => parts.join("/"));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("knowledge navigation", () => {
  it("checks freshness again when opening a class from the same subject overview", async () => {
    await act(async () => root.render(createElement(App)));
    await act(async () => container.querySelector<HTMLButtonElement>(".side-list button")!.click());
    expect(source.refreshSubject.mock.calls).toEqual([[event.fachKey]]);

    await act(async () => container.querySelector<HTMLButtonElement>("main .grouped .row")!.click());

    expect(source.refreshSubject.mock.calls).toEqual([[event.fachKey], [event.fachKey]]);
  });

  it("returns to Heute after opening a notice directly", async () => {
    await act(async () => root.render(createElement(App)));
    await act(async () => container.querySelector<HTMLButtonElement>(".knowledge-highlights .row")!.click());

    expect(container.querySelector(".knowledge-reader h1")?.textContent).toBe(note.title);
    await act(async () => container.querySelector<HTMLButtonElement>("main .backbtn")!.click());

    expect(container.querySelector("main .title")?.textContent).toBe("Heute");
  });

  it("returns to the selected subject overview with its filter", async () => {
    await act(async () => root.render(createElement(App)));
    await act(async () => container.querySelector<HTMLButtonElement>(".side-list button")!.click());
    await act(async () => container.querySelector<HTMLButtonElement>(".subject-knowledge-card")!.click());

    await act(async () => container.querySelector<HTMLButtonElement>("main .backbtn")!.click());

    expect({
      title: container.querySelector("main .title")?.textContent,
      query: container.querySelector<HTMLInputElement>(".spotlight input")?.value,
      subjectNotes: container.querySelectorAll(".subject-knowledge-card").length,
    }).toEqual({ title: "Coding", query: "Coding", subjectNotes: 2 });
  });

  it("shows the note's subject and opens all subject knowledge through Zum Fach", async () => {
    await act(async () => root.render(createElement(App)));
    await act(async () => container.querySelector<HTMLButtonElement>(".knowledge-highlights .row")!.click());

    expect(container.querySelector(".knowledge-meta")?.textContent).toContain("Fach: Coding");
    const subjectButton = [...container.querySelectorAll<HTMLButtonElement>(".knowledge-meta button")].find((button) => button.textContent?.includes("Zum Fach"))!;
    await act(async () => subjectButton.click());

    expect(container.querySelector("main .title")?.textContent).toBe("Coding");
    expect(container.querySelector("main")?.textContent).toContain("Einheiten & Notizen");
    expect(container.querySelectorAll(".subject-knowledge-card")).toHaveLength(2);
    await act(async () => container.querySelector<HTMLButtonElement>(".subject-knowledge-card")!.click());
    await act(async () => container.querySelector<HTMLButtonElement>("main .backbtn")!.click());
    expect(container.querySelector("main .title")?.textContent).toBe("Coding");
  });

  it("does not invent a subject for general study notes", async () => {
    source.notes = [{ ...note, subjectKey: null, subject: null }];
    await act(async () => root.render(createElement(App)));
    await act(async () => container.querySelector<HTMLButtonElement>(".knowledge-highlights .row")!.click());

    expect(container.querySelector(".knowledge-meta")?.textContent).not.toContain("Fach:");
    expect(container.querySelector(".knowledge-meta")?.textContent).not.toContain("Zum Fach");
  });

  it("uses the known subject name when a supplementary note has no subject metadata", async () => {
    source.notes = [{ ...note, subject: null }];
    await act(async () => root.render(createElement(App)));
    await act(async () => container.querySelector<HTMLButtonElement>(".knowledge-highlights .knowledge-link")!.click());

    expect(container.querySelector(".knowledge-list .row-sub")?.textContent).toContain("Coding");
    await act(async () => container.querySelector<HTMLButtonElement>(".knowledge-list .row")!.click());
    expect(container.querySelector(".knowledge-meta")?.textContent).toContain("Fach: Coding");
  });

  it.each([{ noteFile: undefined }, { noteFile: "2026-09-29 Coding.md" }])("opens an exact known class note in its editable class view: %j", async ({ noteFile }) => {
    source.events = [{ ...event, noteFile }];
    source.notes = [{ ...note, body: `# Coding Grundlagen\n\n[[Sem01/${event.terminRel}/${noteFile ?? "notes.md"}|Einheit öffnen]]` }];
    await act(async () => root.render(createElement(App)));
    await act(async () => container.querySelector<HTMLButtonElement>(".knowledge-highlights .row")!.click());
    await act(async () => container.querySelector<HTMLAnchorElement>(".knowledge-reader a[data-wiki]")!.click());

    expect(container.querySelector(".fach .title")?.textContent).toBe("Coding");
    expect(container.querySelector(".knowledge-reader")).toBeNull();
    expect(native.invoke).not.toHaveBeenCalledWith("open_knowledge_file", expect.anything());
    expect(native.invoke).not.toHaveBeenCalledWith("open_vault_file", expect.anything());
  });

  it.each([{ subjectFile: undefined }, { subjectFile: "Coding Übersicht.md" }])("opens an exact subject overview link inside the app: %j", async ({ subjectFile }) => {
    source.events = [{ ...event, subjectFile }];
    source.notes = [{ ...note, body: `# Coding Grundlagen\n\n[[Sem01/01-coding/${subjectFile ?? "Coding.md"}|Zum Fach]]` }];
    await act(async () => root.render(createElement(App)));
    await act(async () => container.querySelector<HTMLButtonElement>(".knowledge-highlights .row")!.click());
    await act(async () => container.querySelector<HTMLAnchorElement>(".knowledge-reader a[data-wiki]")!.click());

    expect(container.querySelector("main .title")?.textContent).toBe("Coding");
    expect(container.querySelector("main")?.textContent).toContain("Einheiten & Notizen");
    expect(native.invoke).not.toHaveBeenCalledWith("open_knowledge_file", expect.anything());
    expect(native.invoke).not.toHaveBeenCalledWith("open_vault_file", expect.anything());
  });

  it("returns from a linked class to its origin note and preserves the preceding note history", async () => {
    source.notes = [note, { ...otherNote, body: `# Weitere Unterlagen\n\n[[Sem01/${event.terminRel}/notes.md|Einheit]]` }];
    await act(async () => root.render(createElement(App)));
    await act(async () => container.querySelector<HTMLButtonElement>(".knowledge-highlights .row")!.click());
    await act(async () => container.querySelector<HTMLAnchorElement>(".knowledge-reader a[data-wiki]")!.click());
    await act(async () => container.querySelector<HTMLAnchorElement>(".knowledge-reader a[data-wiki]")!.click());

    expect(container.querySelector(".fach .backbtn")?.textContent).toContain("Zurück");
    await act(async () => container.querySelector<HTMLButtonElement>(".fach .backbtn")!.click());
    expect(container.querySelector(".knowledge-reader h1")?.textContent).toBe(otherNote.title);
    await act(async () => container.querySelector<HTMLButtonElement>("main .backbtn")!.click());
    expect(container.querySelector(".knowledge-reader h1")?.textContent).toBe(note.title);
    await act(async () => container.querySelector<HTMLButtonElement>("main .backbtn")!.click());
    expect(container.querySelector("main .title")?.textContent).toBe("Heute");
  });

  it("retains the knowledge origin while switching classes in the subject calendar", async () => {
    source.events = [event, { ...event, uid: "coding-next", terminRel: "01-coding/two", start: "2026-09-30T07:00:00.000Z", end: "2026-09-30T08:00:00.000Z" }];
    source.notes = [{ ...note, body: `# Coding Grundlagen\n\n[[Sem01/${event.terminRel}/notes.md|Einheit]]` }];
    await act(async () => root.render(createElement(App)));
    await act(async () => container.querySelector<HTMLButtonElement>(".knowledge-highlights .row")!.click());
    await act(async () => container.querySelector<HTMLAnchorElement>(".knowledge-reader a[data-wiki]")!.click());
    await act(async () => container.querySelector<HTMLButtonElement>('.fach .cal-day[aria-label="2026-09-30, 1 Termine dieses Fachs"]')!.click());

    expect(container.querySelector(".fach .subtitle")?.textContent).toContain("30.09.");
    await act(async () => container.querySelector<HTMLButtonElement>(".fach .backbtn")!.click());
    expect(container.querySelector(".knowledge-reader h1")?.textContent).toBe(note.title);
  });

  it("discards an old knowledge origin when opening a class again from Heute", async () => {
    source.notes = [{ ...note, body: `# Coding Grundlagen\n\n[[Sem01/${event.terminRel}/notes.md|Einheit]]` }];
    await act(async () => root.render(createElement(App)));
    await act(async () => container.querySelector<HTMLButtonElement>(".knowledge-highlights .row")!.click());
    await act(async () => container.querySelector<HTMLAnchorElement>(".knowledge-reader a[data-wiki]")!.click());
    await act(async () => container.querySelector<HTMLButtonElement>('[role="tab"]')!.click());
    await act(async () => container.querySelector<HTMLButtonElement>(".side-list button")!.click());
    await act(async () => container.querySelector<HTMLButtonElement>("main .grouped .row")!.click());

    expect(container.querySelector(".fach .backbtn")?.textContent).toContain("Heute");
    await act(async () => container.querySelector<HTMLButtonElement>(".fach .backbtn")!.click());
    expect(container.querySelector("main .title")?.textContent).toBe("Heute");
  });

  it("opens supplementary knowledge from a class wiki link and returns to that class", async () => {
    source.rawNotes["/mock/Sem01/01-coding/one/notes.md"] = `---\nuid: coding\n---\n\n[[${otherNote.path.replace(/\.md$/, "")}|Assignment 1]]`;
    await act(async () => root.render(createElement(App)));
    await act(async () => container.querySelector<HTMLButtonElement>(".side-list button")!.click());
    await act(async () => container.querySelector<HTMLButtonElement>("main .grouped .row")!.click());
    await act(async () => container.querySelector<HTMLButtonElement>('.fach [role="tablist"] button:nth-child(2)')!.click());

    expect(container.querySelector(".fach-main a[data-wiki]")?.textContent).toBe("Assignment 1");
    await act(async () => container.querySelector<HTMLAnchorElement>(".fach-main a[data-wiki]")!.click());
    expect(container.querySelector(".knowledge-reader h1")?.textContent).toBe(otherNote.title);
    await act(async () => container.querySelector<HTMLButtonElement>("main .backbtn")!.click());
    expect(container.querySelector(".fach .title")?.textContent).toBe("Coding");
    expect(native.invoke).not.toHaveBeenCalledWith("open_knowledge_file", expect.anything());
  });

  it("opens course overview wiki links from a class in the internal subject overview", async () => {
    source.rawNotes["/mock/Sem01/01-coding/one/notes.md"] = "---\nuid: coding\n---\n\n[[Sem01/01-coding/Coding|Fachübersicht]]";
    await act(async () => root.render(createElement(App)));
    await act(async () => container.querySelector<HTMLButtonElement>(".side-list button")!.click());
    await act(async () => container.querySelector<HTMLButtonElement>("main .grouped .row")!.click());
    await act(async () => container.querySelector<HTMLButtonElement>('.fach [role="tablist"] button:nth-child(2)')!.click());
    await act(async () => container.querySelector<HTMLAnchorElement>(".fach-main a[data-wiki]")!.click());

    expect(container.querySelector("main .title")?.textContent).toBe("Coding");
    expect(container.querySelector("main")?.textContent).toContain("Einheiten & Notizen");
    expect(container.querySelector(".fach")).toBeNull();
    expect(native.invoke).not.toHaveBeenCalledWith("open_knowledge_file", expect.anything());
  });

  it("keeps relative class presentation links local when wiki links are enabled", async () => {
    source.rawNotes["/mock/Sem01/01-coding/one/notes.md"] = "---\nuid: coding\n---\n\n[[docs/Presentation.pptx|Präsentation]]";
    await act(async () => root.render(createElement(App)));
    await act(async () => container.querySelector<HTMLButtonElement>(".side-list button")!.click());
    await act(async () => container.querySelector<HTMLButtonElement>("main .grouped .row")!.click());
    await act(async () => container.querySelector<HTMLButtonElement>('.fach [role="tablist"] button:nth-child(2)')!.click());
    await act(async () => container.querySelector<HTMLAnchorElement>(".fach-main a[data-wiki]")!.click());

    expect(native.invoke).toHaveBeenCalledWith("open_vault_file", { path: "/mock/Sem01/01-coding/one/docs/Presentation.pptx" });
    expect(native.invoke).not.toHaveBeenCalledWith("open_knowledge_file", expect.anything());
  });

  it("opens presentation links from supplementary class notes through the document API", async () => {
    source.notes = [{ ...note, path: `Sem01/${event.terminRel}/Assignment 1.md`, body: "# Assignment 1\n\n[[docs/Presentation.pptx|Präsentation öffnen]]" }];
    await act(async () => root.render(createElement(App)));
    await act(async () => container.querySelector<HTMLButtonElement>(".knowledge-highlights .row")!.click());
    await act(async () => container.querySelector<HTMLAnchorElement>(".knowledge-reader a[data-wiki]")!.click());

    expect(native.invoke).toHaveBeenCalledWith("open_vault_file", { path: "/mock/Sem01/01-coding/one/docs/Presentation.pptx" });
    expect(native.invoke).not.toHaveBeenCalledWith("open_knowledge_file", expect.anything());
    expect(container.querySelector(".knowledge-reader h1")?.textContent).toBe("Assignment 1");
  });

  it("preserves the knowledge-file API for PDFs outside class document directories", async () => {
    source.notes = [{ ...note, body: "# Coding Grundlagen\n\n[[Studium/Quellen/Prüfungen.pdf|Quelle öffnen]]" }];
    await act(async () => root.render(createElement(App)));
    await act(async () => container.querySelector<HTMLButtonElement>(".knowledge-highlights .row")!.click());
    await act(async () => container.querySelector<HTMLAnchorElement>(".knowledge-reader a[data-wiki]")!.click());

    expect(native.invoke).toHaveBeenCalledWith("open_knowledge_file", { path: "/mock/Studium/Quellen/Prüfungen.pdf" });
    expect(native.invoke).not.toHaveBeenCalledWith("open_vault_file", expect.anything());
  });

  it("opens documents beside a known supplementary note after its class leaves the calendar", async () => {
    source.events = [];
    source.notes = [{ ...note, path: `Sem01/${event.terminRel}/Assignment 1.md`, body: "# Assignment 1\n\n[[docs/Presentation.pptx|Präsentation öffnen]]" }];
    await act(async () => root.render(createElement(App)));
    await act(async () => container.querySelector<HTMLButtonElement>(".knowledge-highlights .row")!.click());
    await act(async () => container.querySelector<HTMLAnchorElement>(".knowledge-reader a[data-wiki]")!.click());

    expect(native.invoke).toHaveBeenCalledWith("open_vault_file", { path: "/mock/Sem01/01-coding/one/docs/Presentation.pptx" });
    expect(native.invoke).not.toHaveBeenCalledWith("open_knowledge_file", expect.anything());
  });

  it.each([
    { path: "Sem01/01-coding/one/Assignment 1.md", target: "Sem01/01-coding/unknown/docs/Presentation.pptx" },
    { path: "Sem01/01-coding/one/Assignment 1.md", target: "docs/nested/Presentation.pptx" },
    { path: "Sem02/01-coding/one/Assignment 1.md", target: "docs/Presentation.pptx" },
  ])("does not grant document routing to unrelated directories: %j", async ({ path, target }) => {
    source.events = [];
    source.notes = [{ ...note, path, body: `# Assignment 1\n\n[[${target}|Präsentation öffnen]]` }];
    await act(async () => root.render(createElement(App)));
    await act(async () => container.querySelector<HTMLButtonElement>(".knowledge-highlights .row")!.click());
    await act(async () => container.querySelector<HTMLAnchorElement>(".knowledge-reader a[data-wiki]")!.click());

    expect(native.invoke).not.toHaveBeenCalledWith("open_vault_file", expect.anything());
    expect(native.invoke).toHaveBeenCalledWith("open_knowledge_file", expect.anything());
  });

  it("rejects traversal before choosing a document-opening API", async () => {
    source.notes = [{ ...note, body: "# Coding Grundlagen\n\n[[Sem01/01-coding/one/docs/../Presentation.pptx|Unsichere Datei]]" }];
    await act(async () => root.render(createElement(App)));
    await act(async () => container.querySelector<HTMLButtonElement>(".knowledge-highlights .row")!.click());
    await act(async () => container.querySelector<HTMLAnchorElement>(".knowledge-reader a[data-wiki]")!.click());

    expect(container.querySelector(".knowledge-reader [role=alert]")?.textContent).toContain("Verknüpfte Datei konnte nicht geöffnet werden");
    expect(native.invoke).not.toHaveBeenCalledWith("open_knowledge_file", expect.anything());
    expect(native.invoke).not.toHaveBeenCalledWith("open_vault_file", expect.anything());
  });

  it("restores the knowledge list with its search after reading a note", async () => {
    await act(async () => root.render(createElement(App)));
    await act(async () => container.querySelector<HTMLButtonElement>(".knowledge-highlights .knowledge-link")!.click());
    const search = container.querySelector<HTMLInputElement>(".knowledge-search")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, "Grundlagen");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => container.querySelector<HTMLButtonElement>(".knowledge-list .row")!.click());

    await act(async () => container.querySelector<HTMLButtonElement>("main .backbtn")!.click());

    expect({
      query: container.querySelector<HTMLInputElement>(".knowledge-search")?.value,
      titles: [...container.querySelectorAll(".knowledge-list strong")].map((title) => title.textContent),
    }).toEqual({ query: "Grundlagen", titles: [note.title] });
  });

  it("returns through internal note links before returning to Heute", async () => {
    await act(async () => root.render(createElement(App)));
    await act(async () => container.querySelector<HTMLButtonElement>(".knowledge-highlights .row")!.click());
    await act(async () => container.querySelector<HTMLAnchorElement>(".knowledge-reader a[data-wiki]")!.click());
    expect(container.querySelector(".knowledge-reader h1")?.textContent).toBe(otherNote.title);

    await act(async () => container.querySelector<HTMLButtonElement>("main .backbtn")!.click());
    expect(container.querySelector(".knowledge-reader h1")?.textContent).toBe(note.title);
    await act(async () => container.querySelector<HTMLButtonElement>("main .backbtn")!.click());

    expect(container.querySelector("main .title")?.textContent).toBe("Heute");
  });

  it("keeps Alle Wissensnotizen as a separate navigation to the list", async () => {
    await act(async () => root.render(createElement(App)));
    await act(async () => container.querySelector<HTMLButtonElement>(".knowledge-highlights .row")!.click());

    await act(async () => container.querySelector<HTMLButtonElement>(".knowledge-back")!.click());
    expect(container.querySelectorAll(".knowledge-list .row")).toHaveLength(2);
    await act(async () => container.querySelector<HTMLButtonElement>("main .backbtn")!.click());

    expect(container.querySelector(".knowledge-reader h1")?.textContent).toBe(note.title);
  });

  it("starts a new return path after leaving and reopening knowledge", async () => {
    await act(async () => root.render(createElement(App)));
    await act(async () => container.querySelector<HTMLButtonElement>(".side-list button")!.click());
    await act(async () => container.querySelector<HTMLButtonElement>(".subject-knowledge-card")!.click());
    await act(async () => container.querySelector<HTMLButtonElement>('[role="tab"]')!.click());
    await act(async () => container.querySelector<HTMLButtonElement>(".knowledge-highlights .row")!.click());

    await act(async () => container.querySelector<HTMLButtonElement>("main .backbtn")!.click());

    expect(container.querySelector("main .title")?.textContent).toBe("Heute");
  });

  it.each([
    { basisPfad: "/other-vault", semester: "Sem01" },
    { basisPfad: "/mock", semester: "Sem02" },
  ])("discards the previous subject origin after changing the context to %j", async (context) => {
    await act(async () => root.render(createElement(App)));
    await act(async () => container.querySelector<HTMLButtonElement>(".side-list button")!.click());
    await act(async () => container.querySelector<HTMLButtonElement>(".subject-knowledge-card")!.click());
    source.cfg = { ...source.cfg, ...context };
    await act(async () => root.render(createElement(App)));

    await act(async () => container.querySelector<HTMLButtonElement>("main .backbtn")!.click());

    expect(container.querySelector("main .title")?.textContent).toBe("Heute");
  });
});
