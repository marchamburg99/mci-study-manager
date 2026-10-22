import { describe, expect, it } from "vitest";
import { preparationGroups, unfinishedEvents } from "../src/lib/preparation";
import type { StudyEvent } from "../src/lib/types";

const now = new Date(2026, 9, 5, 10).getTime();
function event(uid: string, day: number, hour = 8): StudyEvent {
  return {
    uid, summary: "Databases", fach: "Databases", typ: "ILV", dozent: "Example", lvNummer: "DB1",
    fachKey: "databases", fachDir: "01-databases", terminRel: `01-databases/${uid}`,
    start: new Date(2026, 9, day, hour).toISOString(), end: new Date(2026, 9, day, hour + 1).toISOString(),
  };
}

describe("preparation status", () => {
  it("does not classify unknown or completed old notes as unfinished", () => {
    const old = event("old", -20);
    expect(unfinishedEvents([old], {}, now)).toEqual([]);
    expect(unfinishedEvents([old], { old: { vorbereitet: true, nachbereitet: true } }, now)).toEqual([]);
    expect(unfinishedEvents([old], { old: { vorbereitet: true, nachbereitet: false } }, now)).toEqual([old]);
  });

  it("includes later today and excludes already ended or distant events", () => {
    const today = event("today", 5, 14);
    const tomorrow = event("tomorrow", 6);
    const groups = preparationGroups([event("ended", 5), today, tomorrow, event("far", 20)], now);
    expect(groups.flatMap((group) => group.list)).toEqual([today, tomorrow]);
  });
});
