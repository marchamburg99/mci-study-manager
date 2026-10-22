import type { StudyEvent } from "./types";
import { parseNote, isSafeRelativePath } from "./notes";
import { subjectFileName } from "./filenames";
import { buildFaecher } from "./ical";
import { addDaysMs, dayKey, startOfDayMs } from "./focus";

export interface KnowledgeNotice {
  id: string;
  title: string;
  at: string;
  kind: "termin" | "frist" | "hinweis";
  sourceUrl: string;
  category?: "pruefung";
  endDate?: string;
  detail?: string;
}

export interface KnowledgeNote {
  isSakaiLive?: boolean;
  path: string;
  title: string;
  body: string;
  subjectKey: string | null;
  subject: string | null;
  retrievedAt: string | null;
  sourceStatus: string | null;
  applicability: string | null;
  cohort: number | null;
  sourceUrls: string[];
  notices: KnowledgeNotice[];
  group?: string;
  examSemester?: string;
}

export interface KnowledgeCatalog {
  notes: KnowledgeNote[];
  warnings: string[];
}

export const MAX_KNOWLEDGE_BYTES = 512 * 1024;
export const MAX_KNOWLEDGE_NOTES = 200;

function string(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function sourceUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 4096) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

function date(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === value ? value : null;
}

function timestamp(value: unknown): value is string {
  return typeof value === "string"
    && /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?(?:Z|[+-](?:(?:0\d|1[0-3]):[0-5]\d|14:00))$/.test(value)
    && date(value.slice(0, 10)) !== null && Number.isFinite(Date.parse(value));
}

export function knowledgePath(value: string): string {
  if (!isSafeRelativePath(value) || value.split("/").some((part) => part.startsWith(".") || part !== part.trim())
    || /[\u007f%?#|]/.test(value)) throw new Error("Ungültiger Wissenspfad.");
  return value;
}

export function parseKnowledgeNote(raw: string, path: string, subjectKey: string | null = null): KnowledgeNote | null {
  knowledgePath(path);
  if (new TextEncoder().encode(raw).length > MAX_KNOWLEDGE_BYTES) throw new Error("Wissensnotiz ist zu groß.");
  const { data, body } = parseNote(raw);
  if (data.uid !== undefined) return null;
  const urls = [...(Array.isArray(data.source_urls) ? data.source_urls : []), data.source_url];
  const sourceUrls = [...new Set(urls.map(sourceUrl).filter((url): url is string => url !== null))];
  const examSemester = string(data.pruefungssemester);
  const notices: KnowledgeNotice[] = [];
  if (data.hinweise !== undefined) {
    if (!Array.isArray(data.hinweise) || data.hinweise.length > 50) throw new Error("Hinweise haben ein ungültiges Format.");
    for (const value of data.hinweise) {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Hinweis ist ungültig.");
      const item = value as Record<string, unknown>;
      if (item.bestaetigt !== true) continue;
      const url = sourceUrl(item.quelle);
      const exam = item.bereich === "pruefung";
      const at = item.datum === undefined ? item.zeitpunkt : exam && item.zeitpunkt === undefined ? date(item.datum) : null;
      const dateOnly = exam && item.datum !== undefined && at !== null;
      if (!string(item.id) || !string(item.titel) || (!dateOnly && !timestamp(at)) || !at || !url || !sourceUrls.includes(url)
        || (item.bereich !== undefined && !exam) || (exam && !examSemester)
        || (exam && !["termin", "frist"].includes(String(item.art)))
        || (item.bis !== undefined && (!dateOnly || !date(item.bis) || String(item.bis) < String(at)))
        || (item.detail !== undefined && (!exam || !string(item.detail)))
        || !["termin", "frist", "hinweis"].includes(String(item.art)) || notices.some((notice) => notice.id === item.id)) {
        throw new Error("Bestätigter Hinweis benötigt eindeutige ID, Titel, Datum mit Zeitzone und eine Quelle der Notiz. Prüfungen benötigen ein Semester und dürfen ein Datum ohne Uhrzeit verwenden.");
      }
      notices.push({ id: String(item.id), title: String(item.titel), at: String(at),
        kind: item.art as KnowledgeNotice["kind"], sourceUrl: url,
        ...(exam ? { category: "pruefung" as const } : {}),
        ...(item.bis !== undefined ? { endDate: String(item.bis) } : {}),
        ...(item.detail !== undefined ? { detail: string(item.detail)! } : {}),
      });
    }
  }
  return {
    path, subjectKey, body, notices, sourceUrls,
    ...(string(data.gruppe) ? { group: string(data.gruppe)! } : {}),
    ...(examSemester ? { examSemester } : {}),
    ...(data.sakai_sync === "v1" ? { isSakaiLive: true } : {}),
    title: data.sakai_sync === "v1" && string(data.fach) ? `Sakai Live: ${string(data.fach)}`
      : body.match(/^#\s+(.+)$/m)?.[1]?.trim() || path.split("/").slice(-1)[0].replace(/\.md$/, ""),
    subject: string(data.fach), retrievedAt: date(data.abgerufen),
    sourceStatus: string(data.quellenstand), applicability: string(data.geltung),
    cohort: Number.isInteger(data.jahrgang) && Number(data.jahrgang) >= 2000 && Number(data.jahrgang) <= 2100 ? Number(data.jahrgang) : null,
  };
}

export function subjectKnowledgePaths(events: StudyEvent[], semester: string) {
  knowledgePath(semester);
  if (semester.includes("/")) throw new Error("Ungültiges Semester.");
  return buildFaecher(events).map((subject) => ({
    key: subject.key,
    path: knowledgePath(`${semester}/${subject.dir}/${(subject.file ?? subjectFileName(subject.name)).replace(/\.md$/, "")} - Sakai.md`),
  }));
}

export function upcomingKnowledge(notices: KnowledgeNote[], nowMs: number) {
  const until = addDaysMs(startOfDayMs(nowMs), 14);
  const seen = new Set<string>();
  return notices.flatMap((note) => note.notices.map((notice) => ({ ...notice, note })))
    .filter((notice) => notice.category !== "pruefung" && Date.parse(notice.at) >= nowMs && Date.parse(notice.at) < until)
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.title.localeCompare(b.title))
    .filter((notice) => {
      const key = JSON.stringify([notice.sourceUrl, Date.parse(notice.at), notice.kind]);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

export function upcomingExams(notes: KnowledgeNote[], nowMs: number, semester: string) {
  const today = dayKey(nowMs);
  const seen = new Set<string>();
  return notes.filter((note) => note.examSemester === semester)
    .flatMap((note) => note.notices.map((notice) => ({ ...notice, note })))
    .filter((notice) => notice.category === "pruefung" && (notice.at.length === 10
      ? (notice.endDate ?? notice.at) >= today : Date.parse(notice.at) >= nowMs))
    .sort((a, b) => {
      const aStart = a.at.length === 10 ? new Date(`${a.at}T00:00:00`).getTime() : Date.parse(a.at);
      const bStart = b.at.length === 10 ? new Date(`${b.at}T00:00:00`).getTime() : Date.parse(b.at);
      return aStart - bStart || Number(b.at.length === 10) - Number(a.at.length === 10) || a.title.localeCompare(b.title);
    })
    .filter((notice) => {
      const key = JSON.stringify([notice.sourceUrl, notice.id, notice.at.length === 10 ? notice.at : Date.parse(notice.at), notice.endDate, notice.note.group]);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

export function resolveKnowledgeLink(target: string, currentPath: string): { path: string; heading: string | null } {
  const [file, ...parts] = target.split("#");
  const decoded = decodeURIComponent(file);
  const heading = parts.join("#") || null;
  if (!decoded) return { path: knowledgePath(currentPath), heading };
  let path = decoded;
  if (path.startsWith("docs/")) path = `${currentPath.slice(0, currentPath.lastIndexOf("/"))}/${path}`;
  if (!/\.[^/]+$/.test(path)) path += ".md";
  return { path: knowledgePath(path), heading };
}
