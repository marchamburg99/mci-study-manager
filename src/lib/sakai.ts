import { invoke } from "@tauri-apps/api/core";
import DOMPurify from "dompurify";
import { displayFileStem } from "./filenames";
import { buildFaecher } from "./ical";
import { knowledgePath, sourceUrl, type KnowledgeNote } from "./knowledge";
import { serializeNote, toLocalDateKey } from "./notes";
import type { StudyEvent } from "./types";

export interface SakaiSite {
  id: string;
  title: string;
  description: string;
}

export interface SakaiSelection {
  siteId: string;
  subjectKey: string | null;
}

export interface SakaiSyncReport {
  updated: number;
  unchanged: number;
  downloaded: number;
  warnings: string[];
  failedSubjectKeys?: string[];
  completedAt: string;
}

export interface SakaiSessionStatus {
  connected: boolean;
  loginOpen: boolean;
  rememberSession: boolean;
  persistenceError: boolean;
}

export async function apiSakaiStatus(
  command: "sakai_status" | "sakai_connect" | "sakai_poll_login" | "sakai_set_remember_session" = "sakai_status",
  remember?: boolean,
): Promise<SakaiSessionStatus> {
  const result = await invoke<unknown>(command, remember === undefined ? undefined : { remember });
  if (!record(result) || typeof result.connected !== "boolean" || typeof result.loginOpen !== "boolean"
    || typeof result.rememberSession !== "boolean" || typeof result.persistenceError !== "boolean") {
    throw new Error("Ungültiger Sakai-Anmeldestatus.");
  }
  return { connected: result.connected, loginOpen: result.loginOpen, rememberSession: result.rememberSession, persistenceError: result.persistenceError };
}

export interface SakaiResource {
  title: string;
  url: string;
  type: string;
  size: number;
  modifiedDate: string | null;
}

export interface SakaiSnapshot {
  site: SakaiSite;
  announcements: { id: string; title: string; body: string; createdOn: number }[];
  resources: SakaiResource[];
  lessons?: { title: string; html: string; url: string }[];
  warnings: string[];
}

export const SAKAI_ORIGIN = "https://sakai.mci4me.at";
export const SAKAI_PDF_PATH = /^Studium\/Quellen\/Sakai-[a-f0-9]{64}\.pdf$/;
export const MAX_SAKAI_PDF_BYTES = 15 * 1024 * 1024;
export const MAX_SAKAI_BATCH_BYTES = 100 * 1024 * 1024;
export const MAX_SAKAI_BATCH_PDFS = 25;

export function sakaiSiteId(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value);
}

export function sakaiSiteUrl(id: string): string {
  if (!sakaiSiteId(id)) throw new Error("Ungültige Sakai-Site.");
  return `${SAKAI_ORIGIN}/portal/site/${encodeURIComponent(id)}`;
}

export function sakaiSourceSite(value: string): string | null {
  const safe = sourceUrl(value);
  if (!safe) return null;
  const url = new URL(safe);
  if (url.origin !== SAKAI_ORIGIN) return null;
  const match = url.pathname.match(/^\/portal\/site\/([^/]+)(?:\/(?:tool|page)\/[^/]+)?\/?$/)
    ?? url.pathname.match(/^\/access\/content\/group\/([^/]+)\//);
  if (!match) return null;
  try {
    const id = decodeURIComponent(match[1]);
    return sakaiSiteId(id) ? id : null;
  } catch { return null; }
}

export function defaultSelections(sites: SakaiSite[], notes: KnowledgeNote[], events: StudyEvent[]): SakaiSelection[] {
  const known = new Set(buildFaecher(events).map(({ key }) => key));
  const mapping = new Map<string, Set<string | null>>();
  for (const note of notes) {
    for (const url of note.sourceUrls) {
      const id = sakaiSourceSite(url);
      if (!id) continue;
      const keys = mapping.get(id) ?? new Set<string | null>();
      keys.add(note.subjectKey);
      mapping.set(id, keys);
    }
  }
  return [...new Map(sites.map((site) => [site.id, site])).values()].flatMap<SakaiSelection>((site) => {
    const keys = mapping.get(site.id);
    if (!keys) return [];
    const subjects = [...keys].filter((key): key is string => key !== null);
    if (subjects.length === 0) return [{ siteId: site.id, subjectKey: null }];
    return subjects.length === 1 && known.has(subjects[0]) ? [{ siteId: site.id, subjectKey: subjects[0] }] : [];
  });
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function site(value: unknown): value is SakaiSite {
  return record(value) && sakaiSiteId(value.id) && typeof value.title === "string" && typeof value.description === "string";
}

export function sakaiSessionError(error: unknown): string | null {
  const message = error instanceof Error ? error.message : error;
  return message === "SAKAI_AUTH_REQUIRED" || message === "SAKAI_CANCELLED" ? message : null;
}

export async function apiSakaiSites(): Promise<SakaiSite[]> {
  try {
    const result: unknown = await invoke("sakai_sites");
    if (!Array.isArray(result) || !result.every(site) || new Set(result.map(({ id }) => id)).size !== result.length) {
      throw new Error("Ungültige Sakai-Sites.");
    }
    return result;
  } catch (error) { throw new Error(sakaiSessionError(error) ?? "Die Sakai-Sites konnten nicht sicher geladen werden."); }
}

export async function apiSakaiSnapshot(siteId: string): Promise<SakaiSnapshot> {
  sakaiSiteUrl(siteId);
  const result: unknown = await invoke("sakai_site_snapshot", { siteId });
  if (!record(result) || !site(result.site) || result.site.id !== siteId
    || !Array.isArray(result.announcements) || !result.announcements.every((item: unknown) => record(item)
      && typeof item.id === "string" && typeof item.title === "string" && typeof item.body === "string"
      && typeof item.createdOn === "number" && Number.isSafeInteger(item.createdOn) && item.createdOn >= 0 && item.createdOn <= 8640000000000000)
    || !Array.isArray(result.resources) || !result.resources.every((item: unknown) => record(item)
      && typeof item.title === "string" && typeof item.url === "string" && typeof item.type === "string"
      && typeof item.size === "number" && Number.isSafeInteger(item.size) && item.size >= 0
      && (item.modifiedDate === null || (typeof item.modifiedDate === "string" && item.modifiedDate.trim().length > 0)))
    || (result.lessons !== undefined && (!Array.isArray(result.lessons) || !result.lessons.every((item: unknown) => record(item)
      && typeof item.title === "string" && typeof item.html === "string" && typeof item.url === "string")))
    || !Array.isArray(result.warnings) || !result.warnings.every((warning: unknown) => typeof warning === "string")) {
    throw new Error("Ungültiger Sakai-Abruf.");
  }
  return result as unknown as SakaiSnapshot;
}

export function sakaiMarkdownText(text: string): string {
  return text.replace(/[\p{Cc}\p{Cf}]/gu, (char) => char === "\n" || char === "\t" ? char : "")
    .replace(/[&<>"'\\`*_{}[\]()#+.!|~$^%=:/-]/g, (char) => `&#${char.codePointAt(0)};`);
}

export function sakaiMarkdownLink(label: string, value: string): string | null {
  const safe = sourceUrl(value);
  if (!safe) return null;
  const target = safe.replace(/[\p{Cc}\p{Cf}<>"'`\\[\]()|]/gu, (char) => encodeURIComponent(char)
    .replace(/[!'()*]/g, (part) => `%${part.charCodeAt(0).toString(16).toUpperCase()}`));
  return `[${sakaiMarkdownText(label.replace(/\s+/g, " ").trim() || "Quelle")}](${target})`;
}

export function sakaiHtmlToMarkdown(html: string): string {
  // Template documents have neither a browsing context nor an active custom-element registry.
  const inert = document.createElement("template").content.ownerDocument;
  const dirty = inert.createElement("div");
  const range = inert.createRange();
  range.selectNodeContents(dirty);
  dirty.append(range.createContextualFragment(html));
  const allowed = ["a", "p", "div", "br", "ul", "ol", "li", "h1", "h2", "h3", "h4", "h5", "h6",
    "strong", "b", "em", "i", "span", "pre", "code", "blockquote", "table", "thead", "tbody", "tr", "td", "th", "hr"];
  const clean = DOMPurify.sanitize(dirty, {
    ALLOWED_TAGS: allowed, ALLOWED_ATTR: ["href"], ALLOW_DATA_ATTR: false, ALLOW_ARIA_ATTR: false,
    FORBID_CONTENTS: ["script", "style", "svg", "math", "iframe", "object", "embed", "template", "noscript", "audio", "video"],
    IN_PLACE: true,
  });
  const walk = (node: Node): string => {
    if (node.nodeType === 3) return sakaiMarkdownText(node.textContent ?? "");
    if (node.nodeType !== 1 && node.nodeType !== 11) return "";
    const tag = node.nodeType === 1 ? (node as Element).tagName.toLowerCase() : "";
    if (tag && !allowed.includes(tag)) return "";
    if (tag === "a") {
      return sakaiMarkdownLink(node.textContent ?? "", (node as Element).getAttribute("href") ?? "")
        ?? sakaiMarkdownText(node.textContent ?? "");
    }
    const text = [...node.childNodes].map(walk).join("");
    if (["br", "hr"].includes(tag)) return "\n";
    if (["td", "th"].includes(tag)) return `${text} `;
    if (["p", "div", "li", "ul", "ol", "pre", "blockquote", "tr", "table", "h1", "h2", "h3", "h4", "h5", "h6"].includes(tag)) {
      return `\n${text}\n`;
    }
    return text;
  };
  return walk(clean).replace(/\n[ \t]+/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

export async function sakaiHash(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function byteStem(value: string, limit: number): string {
  let result = "";
  for (const char of displayFileStem(value)) {
    if (new TextEncoder().encode(result + char).length > limit) break;
    result += char;
  }
  return result.replace(/[. ]+$/g, "") || "Fach";
}

export function sakaiNotePath(title: string, semester: string, hash: string): string {
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("Ungültige Sakai-Notizkennung.");
  const suffix = ` - ${byteStem(semester, 64)} - ${hash}.md`;
  const available = 240 - new TextEncoder().encode(`Sakai Live - ${suffix}`).length;
  return `Studium/Sakai Live - ${byteStem(title, available)}${suffix}`;
}

export function sakaiGeneratedPrefix(semester: string, subjectKey: string | null, title: string, date: string,
  snapshots: SakaiSnapshot[], pdfs: Map<string, string>, pendingPdfs = 0, navigation: { path: string; label: string }[] = []): string {
  const links = navigation.map(({ path, label }) => {
    knowledgePath(path);
    if (!path.endsWith(".md") || /[[\]^*"<>\p{Cf}]/u.test(path)) throw new Error("Ungültiger Sakai-Notizlink.");
    return `[[${path.slice(0, -3)}|${sakaiMarkdownText(label.replace(/\s+/g, " "))}]]`;
  });
  const sorted = [...snapshots].sort((a, b) => a.site.id.localeCompare(b.site.id));
  const overview = sorted.map(({ site }) => `- ${sakaiMarkdownLink(site.title, sakaiSiteUrl(site.id))}\n\n${sakaiHtmlToMarkdown(site.description)}`).join("\n\n");
  const announcements = sorted.map((snapshot) => {
    const rows = [...snapshot.announcements].sort((a, b) => b.createdOn - a.createdOn || a.id.localeCompare(b.id))
      .map((item) => `#### ${sakaiMarkdownText(item.title.replace(/\s+/g, " "))}\n\n`
        + `Veröffentlicht: ${item.createdOn > 0 ? toLocalDateKey(new Date(item.createdOn).toISOString()) : "Kein Datum gemeldet"}.\n\n`
        + sakaiHtmlToMarkdown(item.body)).join("\n\n");
    return `### ${sakaiMarkdownText(snapshot.site.title.replace(/\s+/g, " "))}\n\n${rows || "Im Abruf der letzten 365 Tage wurden keine Ankündigungen gemeldet."}`;
  }).join("\n\n");
  const resources = sorted.map((snapshot) => {
    const rows = [...snapshot.resources].sort((a, b) => a.url.localeCompare(b.url) || a.title.localeCompare(b.title)).map((item) => {
      const link = sakaiMarkdownLink(item.title, item.url);
      if (!link) return "- Ressourcenlink aus Sicherheitsgründen ausgelassen.";
      const pdf = pdfs.get(item.url);
      return `- ${link}${pdf && SAKAI_PDF_PATH.test(pdf) ? ` · [[${pdf}|PDF lokal]]` : ""}`;
    }).join("\n");
    return `### ${sakaiMarkdownText(snapshot.site.title.replace(/\s+/g, " "))}\n\n${rows || "Keine Ressourcen gemeldet."}`;
  }).join("\n\n");
  const lessons = sorted.flatMap((snapshot) => [...(snapshot.lessons ?? [])]
    .sort((a, b) => a.url.localeCompare(b.url) || a.title.localeCompare(b.title))
    .map((lesson) => `### ${sakaiMarkdownText(lesson.title.replace(/\s+/g, " "))}\n\n`
      + `${sakaiMarkdownLink("Quelle", lesson.url) ?? "Quellenlink aus Sicherheitsgründen ausgelassen."}\n\n${sakaiHtmlToMarkdown(lesson.html)}`)).join("\n\n");
  return serializeNote({
    sakai_sync: "v1", sakai_semester: semester, sakai_subject_key: subjectKey, fach: title,
    abgerufen: date, source_urls: sorted.map(({ site }) => sakaiSiteUrl(site.id)),
    quellenstand: "Automatischer Sakai-Abruf; keine Prüfung auf persönliche Geltung",
  }, `# Sakai Live: ${sakaiMarkdownText(title.replace(/\s+/g, " "))}\n\n`
    + (links.length ? `${links.join(" · ")}\n\n` : "")
    + "Automatischer Import. Die Geltung für den aktuellen Jahrgang ist nicht bestätigt; Inhalte können ältere Jahrgänge betreffen.\n\n"
    + `## Quellenübersicht\n\n${overview}\n\n## Ankündigungen der letzten 365 Tage\n\n${announcements}\n\n`
    + (lessons ? `## Lerninhalte aus Sakai\n\n${lessons}\n\n` : "")
    + `## Ressourcen\n\n${resources}\n\n`
    + (pendingPdfs ? `PDF-Abruf teilweise: ${pendingPdfs} PDF-Ressourcen wurden bei diesem Abruf nicht lokal aktualisiert. Die Quellenlinks bleiben verfügbar.\n\n` : ""));
}
