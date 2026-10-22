// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseIcs } from "../src/lib/ical";
import type { StudyEvent } from "../src/lib/types";

const source = vi.hoisted(() => ({ events: [] as StudyEvent[] }));
vi.mock("../src/hooks/useStudyCalendar", () => ({ useStudyCalendar: () => ({
  cfg: { basisPfad: "/mock", semester: "Sem01", icalUrl: "https://example.test/calendar", refreshHours: 12, lastRefresh: null },
  events: source.events, syncing: false, ready: true, desktop: false, error: null, state: "synced",
  refreshNow: vi.fn(), applyConfig: vi.fn(),
}) }));
import App from "../src/App";

let root: Root;
let container: HTMLDivElement;
const event: StudyEvent = {
  uid: "one", summary: "Databases", fach: "Databases", typ: "ILV", dozent: "First", lvNummer: "DB1",
  fachKey: "db1", fachDir: "01-databases", terminRel: "01-databases/one",
  start: "2026-10-05T07:00:00.000Z", end: "2026-10-05T08:00:00.000Z",
};

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  source.events = [event, { ...event, uid: "two", dozent: "Second" },
    { ...event, uid: "other-course", fachKey: "db2", lvNummer: "DB2", dozent: "Third" }];
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("subject navigation", () => {
  it("shows mixed event types under one subject and preserves each type when filtering", async () => {
    source.events = parseIcs(["BEGIN:VCALENDAR", ...[
      { name: "Coding VO", typ: "VO", teacher: "First", lv: "MCiT-M01-101-VO" },
      { name: "Geleitetes Selbststudium Coding", typ: "UE", teacher: "Second", lv: "MCiT-M01-101-UE" },
      { name: "Coding", typ: "ILV", teacher: "Third", lv: "MCiT-M01-101-ILV" },
      { name: "Coding", typ: "VO", teacher: "Fourth", lv: "MCiT-M01-102-VO" },
    ].map((entry, index) => [
      "BEGIN:VEVENT",
      `UID:coding-${index}@example.test`,
      `SUMMARY:${entry.name} (${entry.typ}) - MCiT 26 (${entry.teacher})`,
      `DESCRIPTION:LV-Nummer: ${entry.lv}`,
      "DTSTART:20261005T090000",
      "DTEND:20261005T100000",
      "END:VEVENT",
    ].join("\n")), "END:VCALENDAR"].join("\n"));

    await act(async () => root.render(createElement(App)));
    const subjects = [...container.querySelectorAll<HTMLButtonElement>(".side-list button")];
    const subject = subjects.find((button) => button.title.includes("First"))!;

    expect(subjects).toHaveLength(2);
    expect(subject.querySelector(".side-name")?.textContent).toBe("Coding");
    expect(subject.querySelector(".count")?.textContent).toBe("3");
    expect(subject.title).toBe("Coding · ILV, UE, VO · First, Second, Third");
    await act(async () => subject.click());
    expect(container.querySelector(".subtitle")?.textContent).toContain("3 Termine");
    expect([...container.querySelectorAll("main .grouped .row .ttyp")].map((node) => node.textContent))
      .toEqual(["VO", "UE", "ILV"]);
    expect(container.querySelector("main")?.textContent).not.toContain("Fourth");
  });

  it("groups teachers but filters a selected subject by identity rather than its display name", async () => {
    await act(async () => root.render(createElement(App)));
    const subjects = container.querySelectorAll<HTMLButtonElement>(".side-list button");
    expect(subjects).toHaveLength(2);
    expect(subjects[0].querySelector(".count")?.textContent).toBe("2");
    expect(subjects[0].title).toContain("First, Second");
    await act(async () => subjects[0].click());
    expect(container.querySelector(".subtitle")?.textContent).toContain("2 Termine");
    expect(container.querySelectorAll("main .grouped .row")).toHaveLength(2);
    expect(container.querySelector("main")?.textContent).not.toContain("Third");
  });

  it("clears both the displayed query and subject identity when resetting", async () => {
    await act(async () => root.render(createElement(App)));
    await act(async () => container.querySelector<HTMLButtonElement>(".side-list button")!.click());
    await act(async () => container.querySelector<HTMLButtonElement>(".chip-clear")!.click());
    expect(container.querySelector(".subtitle")?.textContent).toContain("3 Termine");
    expect(container.querySelector<HTMLInputElement>(".spotlight input")?.value).toBe("");
  });
});
