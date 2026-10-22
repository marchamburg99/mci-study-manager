// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KnowledgeHighlights } from "../src/components/KnowledgeHighlights";
import type { KnowledgeNote, KnowledgeNotice } from "../src/lib/knowledge";

const sourceUrl = "https://sakai.example/exams.pdf";
const nowMs = new Date("2026-09-30T12:00:00+02:00").getTime();
const notice: KnowledgeNotice = {
  id: "assignment", title: "Communication Training: Assignment 1+2", at: "2026-11-19T13:15:00+01:00",
  kind: "frist", category: "pruefung", sourceUrl,
};
const note: KnowledgeNote = {
  path: "Studium/Prüfungen.md", title: "Semester und Prüfungsfenster", body: "", subjectKey: null,
  subject: null, retrievedAt: "2026-09-30", sourceStatus: null, applicability: null,
  cohort: 2026, group: "IM", examSemester: "Sem01", sourceUrls: [sourceUrl], notices: [notice],
};
const onOpen = vi.fn();
const onShowAll = vi.fn();
let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.clearAllMocks();
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

describe("KnowledgeHighlights", () => {
  it("shows exam deadlines beyond the fourteen-day notice window in a dedicated section", async () => {
    await act(async () => root.render(createElement(KnowledgeHighlights, {
      notes: [note], nowMs, semester: "Sem01", loading: false, warnings: [], onOpen, onShowAll,
    })));

    const exams = container.querySelector('section[aria-label="Prüfungen & Abgaben"]')!;
    expect(exams.textContent).toContain(notice.title);
    expect(exams.textContent).toContain("19.11.2026");
    expect(exams.textContent).toContain("Abgabe · Gruppe IM · JG2026");
    expect(exams.textContent).toContain(`bis ${new Date(notice.at).toLocaleTimeString("de-AT", { hour: "2-digit", minute: "2-digit" })} Uhr`);
    expect(container.querySelector('section[aria-label="Hinweise aus Sakai"]')?.textContent).not.toContain(notice.title);
  });

  it("shows date ranges, the next year and unknown times without inventing midnight", async () => {
    const range = { ...notice, id: "winter", title: "Schriftliche Prüfung", kind: "termin" as const, at: "2027-02-01", endDate: "2027-02-05", detail: "Der genaue Termin folgt." };
    await act(async () => root.render(createElement(KnowledgeHighlights, {
      notes: [{ ...note, group: "IT", notices: [range] }], nowMs, semester: "Sem01", loading: false, warnings: [], onOpen, onShowAll,
    })));

    const exams = container.querySelector(".exam-list")!;
    expect(exams.textContent).toContain("01.02.2027 bis 05.02.2027");
    expect(exams.textContent).toContain("Uhrzeit offen");
    expect(exams.textContent).toContain("Prüfung · Gruppe IT · JG2026");
    expect(exams.textContent).toContain("Der genaue Termin folgt.");
    expect(exams.textContent).not.toContain("00:00");
  });

  it("keeps an ongoing examination window visible through its last day", async () => {
    const range = { ...notice, at: "2026-09-28", endDate: "2026-09-30", kind: "termin" as const };
    await act(async () => root.render(createElement(KnowledgeHighlights, {
      notes: [{ ...note, notices: [range] }], nowMs, semester: "Sem01", loading: false, warnings: [], onOpen, onShowAll,
    })));

    expect(container.querySelector(".exam-list")?.textContent).toContain("28.09.2026 bis 30.09.2026");
  });

  it("shows the next five dates and expands every remaining date on demand", async () => {
    const notices = Array.from({ length: 7 }, (_, index) => ({
      ...notice, id: `exam-${index}`, title: `Prüfung ${index + 1}`, at: `2026-11-${String(index + 1).padStart(2, "0")}`,
    }));
    await act(async () => root.render(createElement(KnowledgeHighlights, {
      notes: [{ ...note, notices }], nowMs, semester: "Sem01", loading: false, warnings: [], onOpen, onShowAll,
    })));

    expect(container.querySelectorAll(".exam-row")).toHaveLength(5);
    expect(container.querySelector(".exam-show-all")?.textContent).toBe("Alle 7 Termine anzeigen");
    await act(async () => container.querySelector<HTMLButtonElement>(".exam-show-all")!.click());
    expect(container.querySelectorAll(".exam-row")).toHaveLength(7);
    expect(container.querySelector(".exam-show-all")?.getAttribute("aria-expanded")).toBe("true");
    await act(async () => container.querySelector<HTMLButtonElement>(".exam-show-all")!.click());
    expect(container.querySelectorAll(".exam-row")).toHaveLength(5);
  });

  it("opens the source note from both the deadline and the overview button", async () => {
    await act(async () => root.render(createElement(KnowledgeHighlights, {
      notes: [note], nowMs, semester: "Sem01", loading: false, warnings: [], onOpen, onShowAll,
    })));
    await act(async () => container.querySelector<HTMLButtonElement>(".exam-row")!.click());
    await act(async () => container.querySelector<HTMLButtonElement>(".exam-highlights .knowledge-heading button")!.click());

    expect(onOpen.mock.calls).toEqual([[note.path], [note.path]]);
    expect(onShowAll).not.toHaveBeenCalled();
  });

  it("shows only the active semester's exams and retains other upcoming Sakai notices", async () => {
    const other = { ...note, path: "Studium/Sem02.md", examSemester: "Sem02", notices: [{ ...notice, title: "Andere Semesterprüfung" }] };
    const ordinary = { ...note, path: "Studium/Allgemeines.md", examSemester: undefined, notices: [{ ...notice, category: undefined, title: "Informationsveranstaltung", at: "2026-10-02T10:00:00+02:00" }] };
    await act(async () => root.render(createElement(KnowledgeHighlights, {
      notes: [note, other, ordinary], nowMs, semester: "Sem01", loading: false, warnings: [], onOpen, onShowAll,
    })));

    expect(container.textContent).not.toContain("Andere Semesterprüfung");
    const otherSection = container.querySelector('section[aria-label="Hinweise aus Sakai"]')!;
    expect(otherSection.textContent).toContain("Weitere Hinweise aus Sakai");
    expect(otherSection.textContent).toContain("Informationsveranstaltung");
    await act(async () => otherSection.querySelector<HTMLButtonElement>(".knowledge-heading button")!.click());
    expect(onShowAll).toHaveBeenCalledOnce();
  });

  it("distinguishes the short notice window from existing future exams", async () => {
    await act(async () => root.render(createElement(KnowledgeHighlights, {
      notes: [note], nowMs, semester: "Sem01", loading: false, warnings: [], onOpen, onShowAll,
    })));

    expect(container.textContent).toContain("Keine weiteren bestätigten Hinweise für die nächsten 14 Tage");
    expect(container.textContent).not.toContain("Keine anstehenden Prüfungstermine");
  });

  it("preserves loading and partial-read warnings without claiming an empty schedule", async () => {
    await act(async () => root.render(createElement(KnowledgeHighlights, {
      notes: [], nowMs, semester: "Sem01", loading: true, warnings: ["Unlesbar"], onOpen, onShowAll,
    })));

    expect(container.textContent).toContain("Wissensstand wird gelesen");
    expect(container.textContent).toContain("Wissensstand teilweise nicht lesbar");
    expect(container.textContent).not.toContain("Keine anstehenden");
    expect(container.textContent).not.toContain("Keine weiteren bestätigten");
  });
});
