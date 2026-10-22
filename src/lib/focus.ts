import type { StudyEvent } from "./types";

export interface Fokus {
  laufend: StudyEvent | null;
  naechstes: StudyEvent | null;
  bald: boolean;
}

export const VORLAUF_MS = 30 * 60 * 1000;

/** Zeitlogik: laufender Termin gewinnt, sonst nächster Termin (bald = startet in <60 Min). */
export function getFokus(events: StudyEvent[], nowMs = Date.now()): Fokus {
  const sorted = [...events].sort((a, b) => a.start.localeCompare(b.start));
  let laufend: StudyEvent | null = null;
  let naechstes: StudyEvent | null = null;
  for (const e of sorted) {
    const s = Date.parse(e.start);
    const en = Date.parse(e.end);
    if (s <= nowMs && nowMs < en) {
      laufend = e;
      break;
    }
    if (s > nowMs && !naechstes) naechstes = e;
  }
  const bald = naechstes
    ? Date.parse(naechstes.start) - nowMs < 60 * 60 * 1000
    : false;
  return { laufend, naechstes, bald };
}

export function istHeute(iso: string, nowMs = Date.now()): boolean {
  const d = new Date(iso);
  const n = new Date(nowMs);
  return (
    d.getFullYear() === n.getFullYear() &&
    d.getMonth() === n.getMonth() &&
    d.getDate() === n.getDate()
  );
}

export function eventsAmTag(events: StudyEvent[], dayMs: number): StudyEvent[] {
  return events
    .filter((e) => {
      const s = new Date(e.start);
      const d = new Date(dayMs);
      return (
        s.getFullYear() === d.getFullYear() &&
        s.getMonth() === d.getMonth() &&
        s.getDate() === d.getDate()
      );
    })
    .sort((a, b) => a.start.localeCompare(b.start));
}

export function formatZeit(iso: string): string {
  return new Date(iso).toLocaleTimeString("de-AT", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatTag(iso: string): string {
  return new Date(iso).toLocaleDateString("de-AT", {
    weekday: "short",
    day: "2-digit",
    month: "2-digit",
  });
}

// ── Tages-Helfer (lokal, für Kalender & Vorbereiten) ──────────────────

/** Lokaler Tages-Schlüssel YYYY-MM-DD. */
export function dayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function startOfDayMs(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function addDaysMs(ms: number, n: number): number {
  const d = new Date(ms);
  d.setDate(d.getDate() + n);
  return d.getTime();
}

/** "Heute", "Morgen", "In n Tagen" … — für Tages-Überschriften. */
export function relDayLabel(targetMs: number, nowMs: number): string {
  const diff = Math.round((startOfDayMs(targetMs) - startOfDayMs(nowMs)) / 86_400_000);
  if (diff === 0) return "Heute";
  if (diff === 1) return "Morgen";
  if (diff === -1) return "Gestern";
  if (diff > 1) return `In ${diff} Tagen`;
  return `Vor ${-diff} Tagen`;
}
