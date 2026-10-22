import type { AppConfig, StudyEvent } from "./types";
import { parseIcs } from "./ical";
import { errorMessage } from "./config";
import { apiFetchIcal, apiReadText, apiSaveText, calendarCachePath, ensureVault, resolveEventPaths } from "./storage";
import { loadSubjectExclusions } from "./subjectExclusions";

export interface CalendarResult {
  events: StudyEvent[];
  config: AppConfig;
  state: "synced" | "cached" | "offline";
  warning: string | null;
}

function readCalendar(text: string): StudyEvent[] {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter(Boolean);
  const invalid = () => new Error("Die Antwort enthält keinen vollständigen Kalender.");
  if (lines.shift() !== "BEGIN:VCALENDAR") throw invalid();
  const stack = ["VCALENDAR"];
  let version = false;
  for (const line of lines) {
    if (!stack.length) throw invalid();
    if (/^[ \t]/.test(line)) continue;
    if (line.startsWith("BEGIN:")) {
      const component = line.slice(6);
      if (!component || component === "VCALENDAR") throw invalid();
      stack.push(component);
    } else if (line.startsWith("END:")) {
      if (stack.pop() !== line.slice(4)) throw invalid();
    } else if (!line.includes(":")) throw invalid();
    else if (stack.length === 1 && line === "VERSION:2.0") version = true;
  }
  if (stack.length || !version) throw invalid();
  const events = parseIcs(text);
  if (events.length === 0 && text.includes("BEGIN:VEVENT")) {
    throw new Error("Der Kalender enthält Termine, aber keine lesbaren Lehrveranstaltungen.");
  }
  return events;
}

export async function syncCalendar(cfg: AppConfig, force = false): Promise<CalendarResult> {
  const exclusions = await loadSubjectExclusions(cfg);
  const active = (events: StudyEvent[]) => events.filter((event) => !exclusions.subjectKeys.has(event.fachKey));
  const path = await calendarCachePath(cfg);
  const cached = await apiReadText(path);
  let cachedEvents: StudyEvent[] | null = null;
  if (cached !== null) {
    try { cachedEvents = readCalendar(cached); }
    catch { /* A damaged cache may be replaced only by a validated fresh response. */ }
  }
  const age = cfg.lastRefresh ? Date.now() - Date.parse(cfg.lastRefresh) : Infinity;
  if (!force && cachedEvents !== null && age >= 0 && age < cfg.refreshHours * 3_600_000) {
    const events = await resolveEventPaths(cfg, active(cachedEvents));
    await ensureVault(cfg, events);
    return { events, config: cfg, state: "cached", warning: null };
  }
  try {
    const text = await apiFetchIcal(cfg.icalUrl);
    const events = await resolveEventPaths(cfg, active(readCalendar(text)));
    await ensureVault(cfg, events);
    await apiSaveText(path, text, cached);
    return {
      events,
      config: { ...cfg, lastRefresh: new Date().toISOString() },
      state: "synced",
      warning: null,
    };
  } catch (error) {
    if (cachedEvents === null) throw error;
    const events = await resolveEventPaths(cfg, active(cachedEvents));
    await ensureVault(cfg, events);
    return {
      events,
      config: cfg,
      state: "offline",
      warning: `Synchronisation fehlgeschlagen. Gespeicherter Stundenplan wird angezeigt: ${errorMessage(error)}`,
    };
  }
}
