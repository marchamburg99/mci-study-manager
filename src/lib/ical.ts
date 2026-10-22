import type { EventType, StudyEvent } from "./types";
import { toLocalDateKey, toLocalTimeKey } from "./notes.ts";

/** ä->ae, ö->oe, ü->ue, ß->ss, dann slug */
export function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

/** Nachname des Dozenten für Ordnernamen, z.B. "FH-Prof. Dr. Reinhard Bernsteiner" -> "bernsteiner" */
export function dozentSlug(dozent: string): string {
  const cleaned = dozent.split(",")[0].trim();
  const parts = cleaned.split(/\s+/).filter(Boolean);
  const last = parts[parts.length - 1] ?? "unbekannt";
  return slug(last) || "unbekannt";
}

const SUMMARY_RE = /^(.*?)\s*\((VO|UE|ILV)\)\s*-\s*MCiT[^(]*\((.*)\)\s*$/i;
/** Fallback für abweichende Gruppenkürzel, z.B. "... (ILV) - BA MCiT 26 (Name)" */
const SUMMARY_RE_LOOSE = /^(.*?)\s*(?:\((VO|UE|ILV)\))?\s*-\s*[^(]+\((.*)\)\s*$/i;

export function subjectName(name: string): string {
  return name.normalize("NFC").replace(/\s+/g, " ").trim()
    .replace(/^Geleitetes Selbststudium(?:\s+|$)/i, "")
    .replace(/(?:^|\s+)(?:VO|UE|ILV)$|\s*\(\s*(?:VO|UE|ILV)\s*\)$/i, "").trim();
}

export function subjectIdentity(lvNummer: string, fach: string): string {
  const normalized = lvNummer.normalize("NFC").toLowerCase().replace(/\s+/g, " ").trim();
  return normalized
    ? JSON.stringify(["lv", normalized.replace(/-(?:VO|UE|ILV)$/i, "").trim()])
    : JSON.stringify(["name", subjectName(fach).toLowerCase()]);
}

function compareText(a: string, b: string): number {
  return a.localeCompare(b, "de") || (a < b ? -1 : a > b ? 1 : 0);
}

function subjectSlug(fach: string, typ: EventType): string {
  const fachSlug = slug(fach) || "fach";
  const typSlug = slug(typ);
  return fachSlug === typSlug || fachSlug.endsWith(`-${typSlug}`)
    ? fachSlug
    : `${fachSlug}-${typSlug}`;
}

function subjectHash(identity: string): string {
  // FNV-1a-128 bounds path/tag keys without losing punctuation or long suffixes.
  let hash = 0x6c62272e07bb014262b821756295c58dn;
  for (const byte of new TextEncoder().encode(identity)) {
    hash = BigInt.asUintN(128, (hash ^ BigInt(byte)) * 0x1000000000000000000013bn);
  }
  return hash.toString(16).padStart(32, "0");
}

export function parseSummary(summary: string): {
  fach: string;
  typ: EventType;
  dozent: string;
} {
  const oneLine = summary.replace(/\s+/g, " ").trim();
  const m = oneLine.match(SUMMARY_RE) ?? oneLine.match(SUMMARY_RE_LOOSE);
  if (!m) return { fach: subjectName(oneLine), typ: "SONST", dozent: "" };
  return {
    fach: subjectName(m[1] ?? oneLine),
    typ: ((m[2] ?? "").toUpperCase() || "SONST") as EventType,
    dozent: (m[3] ?? "").trim(),
  };
}

export function parseLvNummer(description: string): string {
  const flat = description.replace(/\r?\n[ \t]/g, "");
  const m = flat.match(/LV-Nummer:[ \t]*(\S+)/i);
  return m ? m[1].trim() : "";
}

// ── Minimaler ICS-Parser (ohne Dependencies) ─────────────────────────
// node-ical braucht Node-Built-ins (fs/crypto/buffer) und läuft im
// Browser ins Leere — stiller Totalausfall. Dieser Parser kann nur, was
// der MCI-Feed braucht: ungefaltete VEVENTs mit UID/SUMMARY/DESCRIPTION/
// DTSTART/DTEND. Dadurch identisch in Node, Browser und Tauri.

// RFC 5545 §3.1: Folgezeilen mit Leerzeichen/Tab gehören zur Vorzeile.
function unfoldLines(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/\r\n|\r|\n/)) {
    if ((line.startsWith(" ") || line.startsWith("\t")) && out.length > 0) {
      out[out.length - 1] += line.slice(1);
    } else {
      out.push(line);
    }
  }
  return out;
}

interface RawProp {
  name: string;
  params: string;
  value: string;
}

/** RFC 5545 §3.3.11: TEXT-Escapes auflösen (\\ \, \; \n). */
function unescapeText(s: string): string {
  return s.replace(/\\(\\|;|,|n|N)/g, (_m, c: string) =>
    c === "n" || c === "N" ? "\n" : c,
  );
}

function splitProp(line: string): RawProp | null {
  const i = line.indexOf(":");
  if (i <= 0) return null;
  const head = line.slice(0, i);
  const semi = head.indexOf(";");
  return {
    name: (semi === -1 ? head : head.slice(0, semi)).toUpperCase(),
    params: semi === -1 ? "" : head.slice(semi + 1).toUpperCase(),
    value: line.slice(i + 1),
  };
}

function tzidOf(params: string): string | undefined {
  const m = params.match(/TZID=([^;]+)/);
  return m ? m[1] : undefined;
}

// EU-Sommerzeit: letzter Sonntag im März 01:00 UTC bis letzter Sonntag
// im Oktober 01:00 UTC (gilt stabil seit 1996 — Feed-Horizont 2026).
function lastSunday(year: number, month0: number): number {
  const last = new Date(Date.UTC(year, month0 + 1, 0));
  return last.getUTCDate() - ((last.getUTCDay() + 7 - 0) % 7);
}

function viennaOffsetAtUTC(u: Date): number {
  const y = u.getUTCFullYear();
  const start = Date.UTC(y, 2, lastSunday(y, 2), 1, 0, 0);
  const end = Date.UTC(y, 9, lastSunday(y, 9), 1, 0, 0);
  const t = u.getTime();
  return t >= start && t < end ? 120 : 60;
}

/** Wandelt ICS-Datum in UTC-ISO um. Ohne Z/TZID = Wiener Wandzeit (MCI-Feed). */
function parseICSDate(value: string, tzid: string | undefined): string | null {
  const m = value.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (!m[4]) {
    // Ganztägig: Tagesbeginn in Wien.
    return viennaWallToUTC(y, mo, d, 0, 0).toISOString();
  }
  const h = Number(m[4]);
  const mi = Number(m[5]);
  const s = Number(m[6]);
  if (m[7] === "Z" || (tzid && /^(UTC|GMT|Z)$/.test(tzid))) {
    return new Date(Date.UTC(y, mo - 1, d, h, mi, s)).toISOString();
  }
  const utc = viennaWallToUTC(y, mo, d, h, mi);
  utc.setUTCSeconds(s);
  return utc.toISOString();
}

/** Wiener Wandzeit -> UTC (zwei Durchgänge, konvergiert an den Grenzen). */
function viennaWallToUTC(y: number, mo: number, d: number, h: number, mi: number): Date {
  let off = 60;
  for (let i = 0; i < 3; i++) {
    off = viennaOffsetAtUTC(new Date(Date.UTC(y, mo - 1, d, h, mi) - off * 60_000));
  }
  return new Date(Date.UTC(y, mo - 1, d, h, mi) - off * 60_000);
}

interface RawVevent {
  uid?: string;
  summary?: string;
  description?: string;
  start?: string;
  end?: string;
}

function extractVevents(lines: string[]): RawVevent[] {
  const out: RawVevent[] = [];
  let cur: RawVevent | null = null;
  for (const line of lines) {
    if (line === "BEGIN:VEVENT") {
      cur = {};
      continue;
    }
    if (line === "END:VEVENT") {
      if (cur) out.push(cur);
      cur = null;
      continue;
    }
    if (!cur) continue;
    const p = splitProp(line);
    if (!p) continue;
    if (p.name === "UID") cur.uid = (cur.uid ?? "") + p.value;
    else if (p.name === "SUMMARY") cur.summary = (cur.summary ?? "") + unescapeText(p.value);
    else if (p.name === "DESCRIPTION") cur.description = (cur.description ?? "") + unescapeText(p.value);
    else if (p.name === "DTSTART") cur.start = parseICSDate(p.value, tzidOf(p.params)) ?? undefined;
    else if (p.name === "DTEND") cur.end = parseICSDate(p.value, tzidOf(p.params)) ?? undefined;
  }
  return out;
}

// Lokales Datum statt UTC-slice: Implementierung in notes.ts
// (start liegt als UTC-ISO vor, Anzeige/Ordner vergleichen aber lokal).

/**
 * Parst ICS-Text zu normalisierten StudyEvents.
 * Überspringt: alles außer VEVENTs, Events ohne Datum/UID,
 * Sondertermine ohne Typ/Dozent (Welcome etc.).
 */
export function parseIcs(icsText: string): StudyEvent[] {
  const raw = extractVevents(unfoldLines(icsText));
  type Tmp = Omit<StudyEvent, "fachDir" | "terminRel"> & { dateKey: string };
  const tmp: Tmp[] = [];
  const uids = new Set<string>();
  const identities = new Map<string, string>();

  for (const ev of raw) {
    if (!ev.uid || !ev.summary) continue;
    const start = ev.start ?? null;
    const end = ev.end ?? null;
    if (!start || !end) continue;

    const { fach, typ, dozent } = parseSummary(ev.summary);
    const lvNummer = parseLvNummer(ev.description ?? "");
    // Sondertermine (Welcome etc.) aussortieren: kein Typ, kein Dozent
    if (typ === "SONST") continue;
    if (uids.has(ev.uid)) throw new Error("Der Kalender enthält eine doppelte Termin-UID.");
    uids.add(ev.uid);

    const source = lvNummer.trim() ? "lv" : "name";
    const identity = subjectIdentity(lvNummer, fach);
    const fachKey = `${source}-${subjectHash(identity)}`;
    const previous = identities.get(fachKey);
    if (previous !== undefined && previous !== identity) {
      throw new Error("Der Kalender enthält kollidierende Fachschlüssel.");
    }
    identities.set(fachKey, identity);
    const dateKey = toLocalDateKey(start);
    tmp.push({
      uid: String(ev.uid),
      summary: ev.summary,
      fach,
      typ,
      dozent,
      lvNummer,
      fachKey,
      start,
      end,
      dateKey,
    });
  }

  const fachJeKey = new Map<string, { fach: string }>();
  for (const t of tmp) {
    const current = fachJeKey.get(t.fachKey);
    if (!current || compareText(t.fach, current.fach) < 0) {
      fachJeKey.set(t.fachKey, { fach: t.fach });
    }
  }

  // Initial path suggestions; resolveEventPaths owns the persisted assignments.
  const subjects = [...fachJeKey.entries()].sort(([ka, a], [kb, b]) =>
    compareText(a.fach, b.fach) || compareText(ka, kb));
  const dirJeKey = new Map(subjects.map(([key, subject], i) => {
    return [key, `${String(i + 1).padStart(2, "0")}-${slug(subject.fach) || "fach"}`] as const;
  }));

  // Termin-Ordner, Kollisionen am selben Tag -> Uhrzeit anhängen
  const seen = new Set<string>();
  tmp.sort((a, b) => a.start.localeCompare(b.start) || a.uid.localeCompare(b.uid));

  return tmp.map((t) => {
    const fach = fachJeKey.get(t.fachKey)!.fach;
    const fachDir = dirJeKey.get(t.fachKey)!;
    const base = `${t.dateKey}_${subjectSlug(fach, t.typ)}`;
    const ck = `${fachDir}/${base}`;
    let folder = seen.has(ck) ? `${base}-${toLocalTimeKey(t.start)}` : base;
    const timed = folder;
    let suffix = 2;
    while (seen.has(`${fachDir}/${folder}`)) folder = `${timed}-${suffix++}`;
    seen.add(`${fachDir}/${folder}`);
    return {
      uid: t.uid,
      summary: t.summary,
      fach,
      typ: t.typ,
      dozent: t.dozent,
      lvNummer: t.lvNummer,
      fachKey: t.fachKey,
      fachDir,
      start: t.start,
      end: t.end,
      terminRel: `${fachDir}/${folder}`,
    };
  });
}

/** Fächerliste für die Übersicht, sortiert nach Namen. */
export function buildFaecher(events: StudyEvent[]) {
  const map = new Map<string, StudyEvent[]>();
  for (const e of events) {
    const group = map.get(e.fachKey) ?? [];
    group.push(e);
    map.set(e.fachKey, group);
  }
  return [...map.entries()]
    .map(([key, group]) => {
      const representative = [...group].sort((a, b) =>
        Number(b.subjectDir !== undefined) - Number(a.subjectDir !== undefined)
        || compareText(a.subjectDir ?? a.fachDir, b.subjectDir ?? b.fachDir)
        || Number(b.subjectFile !== undefined) - Number(a.subjectFile !== undefined)
        || compareText(a.subjectFile ?? "", b.subjectFile ?? ""))[0];
      return {
        key,
        name: group.map((e) => subjectName(e.fach)).sort(compareText)[0],
        types: [...new Set(group.map((e) => e.typ))].sort(compareText),
        dozent: [...new Set(group.map((e) => e.dozent.trim()).filter(Boolean))].sort(compareText).join(", "),
        dir: representative.subjectDir ?? representative.fachDir,
        file: representative.subjectFile,
        termine: group.length,
      };
    })
    .sort((a, b) => compareText(a.name, b.name) || compareText(a.key, b.key));
}
