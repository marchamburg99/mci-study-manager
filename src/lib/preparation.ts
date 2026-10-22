import type { StudyEvent } from "./types";
import { addDaysMs, dayKey, startOfDayMs } from "./focus";

export type PreparationStatus = { vorbereitet: boolean; nachbereitet: boolean };

export function preparationGroups(events: StudyEvent[], nowMs: number) {
  const groups: { ms: number; list: StudyEvent[] }[] = [];
  const today = startOfDayMs(nowMs);
  for (let i = 0; i < 8; i++) {
    const ms = addDaysMs(today, i);
    const key = dayKey(ms);
    const list = events
      .filter((event) => dayKey(Date.parse(event.start)) === key && Date.parse(event.end) > nowMs)
      .sort((a, b) => a.start.localeCompare(b.start));
    if (list.length) groups.push({ ms, list });
  }
  return groups;
}

export function unfinishedEvents(events: StudyEvent[], statuses: Record<string, PreparationStatus>, nowMs: number) {
  return events
    .filter((event) => Date.parse(event.end) <= nowMs && statuses[event.uid]?.nachbereitet === false)
    .sort((a, b) => b.start.localeCompare(a.start));
}
