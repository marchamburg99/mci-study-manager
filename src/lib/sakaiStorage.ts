import { invoke } from "@tauri-apps/api/core";
import { join } from "@tauri-apps/api/path";
import { subjectFileName } from "./filenames";
import { buildFaecher } from "./ical";
import { validateNoteFile, validateRelativePath } from "./identity";
import { knowledgePath, MAX_KNOWLEDGE_BYTES, sourceUrl } from "./knowledge";
import { parseNote, toLocalDateKey } from "./notes";
import { apiEnsureDir, apiListDocs, apiReadText, apiSaveText, isConflictError } from "./storage";
import { loadSubjectExclusions } from "./subjectExclusions";
import {
  apiSakaiSnapshot, MAX_SAKAI_PDF_BYTES, MAX_SAKAI_BATCH_BYTES, MAX_SAKAI_BATCH_PDFS, SAKAI_ORIGIN, SAKAI_PDF_PATH,
  sakaiGeneratedPrefix, sakaiHash, sakaiNotePath, sakaiSessionError, sakaiSiteId, sakaiSiteUrl, sakaiSourceSite,
  type SakaiResource, type SakaiSelection, type SakaiSnapshot, type SakaiSyncReport,
} from "./sakai";
import type { AppConfig, FachInfo, StudyEvent } from "./types";

interface PdfCacheEntry {
  url: string;
  modifiedDate: string | null;
  size: number;
  path: string;
}

interface SakaiCache {
  version: "v1";
  semester: string;
  pdfs: PdfCacheEntry[];
  pending: string[];
}

interface SakaiGroup {
  subjectKey: string | null;
  subject: FachInfo | null;
  siteIds: string[];
}

type Checked = <T>(operation: () => Promise<T>) => Promise<T>;

function keys(value: unknown, expected: string[]): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === expected.length && expected.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function resourceUrl(value: unknown): value is string {
  if (typeof value !== "string" || sourceUrl(value) !== value || sakaiSourceSite(value) === null) return false;
  return new URL(value).pathname.startsWith("/access/content/group/");
}

function readCache(raw: string | null, semester: string): SakaiCache {
  const empty: SakaiCache = { version: "v1", semester, pdfs: [], pending: [] };
  if (raw === null) return empty;
  if (new TextEncoder().encode(raw).length > 2 * 1024 * 1024) throw new Error("Ungültiger Sakai-Cache.");
  const value: unknown = JSON.parse(raw);
  if (!keys(value, ["version", "semester", "pdfs", "pending"]) || value.version !== "v1" || value.semester !== semester
    || !Array.isArray(value.pdfs) || value.pdfs.length > 10000 || !value.pdfs.every((entry: unknown) =>
      keys(entry, ["url", "modifiedDate", "size", "path"]) && resourceUrl(entry.url)
      && (entry.modifiedDate === null || (typeof entry.modifiedDate === "string" && entry.modifiedDate.length > 0 && entry.modifiedDate.length <= 256))
      && typeof entry.size === "number" && Number.isSafeInteger(entry.size) && entry.size > 0 && entry.size <= MAX_SAKAI_PDF_BYTES
      && typeof entry.path === "string" && SAKAI_PDF_PATH.test(entry.path))
    || new Set(value.pdfs.map((entry: PdfCacheEntry) => entry.url)).size !== value.pdfs.length
    || !Array.isArray(value.pending) || value.pending.length > 10000 || !value.pending.every(resourceUrl)
    || new Set(value.pending).size !== value.pending.length) throw new Error("Ungültiger Sakai-Cache.");
  return value as unknown as SakaiCache;
}

function groupsFor(selections: SakaiSelection[], events: StudyEvent[], warnings: string[]): SakaiGroup[] {
  const subjects = new Map(buildFaecher(events).map((subject) => [subject.key, subject]));
  const selected = new Map<string, Set<string | null>>();
  for (const selection of selections) {
    if (!sakaiSiteId(selection.siteId) || (selection.subjectKey !== null && !subjects.has(selection.subjectKey))) {
      warnings.push("Eine ungültige oder nicht mehr zugeordnete Sakai-Auswahl wurde übersprungen.");
      continue;
    }
    const keys = selected.get(selection.siteId) ?? new Set<string | null>();
    keys.add(selection.subjectKey);
    selected.set(selection.siteId, keys);
  }
  const groups = new Map<string, SakaiGroup>();
  for (const [siteId, keys] of [...selected].sort(([a], [b]) => a.localeCompare(b))) {
    if (keys.size !== 1) {
      warnings.push("Eine mehrfach zugeordnete Sakai-Site wurde übersprungen.");
      continue;
    }
    const subjectKey = [...keys][0];
    const identity = JSON.stringify(subjectKey === null ? ["site", siteId] : ["subject", subjectKey]);
    const group = groups.get(identity) ?? { subjectKey, subject: subjectKey === null ? null : subjects.get(subjectKey)!, siteIds: [] };
    group.siteIds.push(siteId);
    groups.set(identity, group);
  }
  return [...groups.values()];
}

async function personalSuffix(raw: string | null, semester: string, group: SakaiGroup, checked: Checked): Promise<string> {
  if (raw === null) return "\n\n## Persönliche Notizen\n";
  const markers = [...raw.matchAll(/<!--\s*sm:sakai:/g)];
  const marker = /^<!-- sm:sakai:([a-f0-9]{64}) -->/m.exec(raw);
  if (markers.length !== 1 || !marker || marker.index !== markers[0].index) throw new Error("CONFLICT");
  const prefix = raw.slice(0, marker.index);
  if (await checked(() => sakaiHash(prefix)) !== marker[1]) throw new Error("CONFLICT");
  const { data } = parseNote(prefix);
  if (data.sakai_sync !== "v1" || data.sakai_semester !== semester || data.sakai_subject_key !== group.subjectKey
    || (group.subjectKey === null && (!Array.isArray(data.source_urls) || data.source_urls.length !== 1
      || data.source_urls[0] !== sakaiSiteUrl(group.siteIds[0])))) throw new Error("CONFLICT");
  return raw.slice(marker.index + marker[0].length);
}

function snapshotFailure(error: unknown): string | null {
  const message = error instanceof Error ? error.message : error;
  if (typeof message !== "string") return null;
  const match = /^SAKAI_SNAPSHOT:(site|announcements|resources|lessons):(.+)$/.exec(message);
  const reasons = [
    "Sakai-Zugriff nicht freigegeben", "Sakai-Anfrage fehlgeschlagen", "Sakai meldet eine unerwartete Antwort",
    "Sakai-Antwort hat ein unbekanntes Datenformat", "Sakai-Daten überschreiten die Sicherheitsgrenze; Ergebnis unvollständig",
    "Sakai-Anmeldung konnte nicht gestartet werden",
    "Sakai-Sitzung konnte nicht sicher gespeichert oder entfernt werden. Bitte erneut versuchen.",
  ];
  if (!match || match[0] !== message || !reasons.includes(match[2])) return null;
  const stages: Record<string, string> = { site: "Kursinformationen", announcements: "Ankündigungen", resources: "Dateien", lessons: "Lerninhalte" };
  return `${stages[match[1]]}: ${match[2]}`;
}

function isPdf(resource: SakaiResource): boolean {
  const mime = resource.type.split(";")[0].trim().toLowerCase();
  const url = sourceUrl(resource.url);
  return mime === "application/pdf" || (url !== null && new URL(url).pathname.toLowerCase().endsWith(".pdf"));
}

export async function syncSakai(
  cfg: Pick<AppConfig, "basisPfad" | "semester">,
  events: StudyEvent[],
  selections: SakaiSelection[],
  options: { isCurrent: () => boolean; onProgress: (message: string) => void; prioritySubjectKey?: string },
): Promise<SakaiSyncReport> {
  const current = () => { if (!options.isCurrent()) throw new Error("SAKAI_CANCELLED"); };
  const checked: Checked = async (operation) => {
    current();
    try { return await operation(); }
    finally { current(); }
  };
  current();
  const root = cfg.basisPfad;
  const semester = knowledgePath(cfg.semester);
  if (semester.includes("/") || !root) throw new Error("Ungültige Sakai-Einstellungen.");
  const exclusions = await loadSubjectExclusions(cfg, checked);
  const report: SakaiSyncReport = { updated: 0, unchanged: 0, downloaded: 0, warnings: [], completedAt: "" };
  const activeSelections = selections.filter((selection) => !exclusions.sakaiSiteIds.has(selection.siteId)
    && (selection.subjectKey === null || !exclusions.subjectKeys.has(selection.subjectKey)));
  const groups = groupsFor(activeSelections, events, report.warnings);
  const date = toLocalDateKey(new Date().toISOString());
  const hash = await checked(() => sakaiHash(semester));
  const cachePath = await checked(() => join(root, ".mci-manager", `sakai-${hash}.json`));
  let expectedCache: string | null = null;
  let cache = readCache(null, semester);
  let canSaveCache = true;
  try {
    expectedCache = await checked(() => apiReadText(cachePath));
    cache = readCache(expectedCache, semester);
  } catch (error) {
    if (sakaiSessionError(error)) throw error;
    canSaveCache = false;
    report.warnings.push("Der Sakai-Cache ist nicht sicher lesbar und bleibt unverändert; PDFs werden erneut geprüft.");
  }
  const cached = new Map(cache.pdfs.map((entry) => [entry.url, entry]));
  const pending = new Set(cache.pending);
  const priority = new Map(cache.pending.map((url, index) => [url, index]));
  const groupPriority = (group: SakaiGroup) => cache.pending.findIndex((url) => group.siteIds.includes(sakaiSourceSite(url)!));
  const todaySubjects = new Set(events.filter((event) => toLocalDateKey(event.start) === date).map((event) => event.fachKey));
  const subjectPriority = (group: SakaiGroup) => {
    if (group.subjectKey === options.prioritySubjectKey) return 0;
    return group.subjectKey !== null && todaySubjects.has(group.subjectKey) ? 1 : 2;
  };
  groups.sort((a, b) => subjectPriority(a) - subjectPriority(b)
    || (groupPriority(a) < 0 ? Infinity : groupPriority(a)) - (groupPriority(b) < 0 ? Infinity : groupPriority(b)));
  const downloaded = new Map<string, PdfCacheEntry>();
  const failedDownloads = new Set<string>();
  const externalPdfs = new Set<string>();
  const oversizedPdfs = new Set<string>();
  const saveCache = async () => {
    if (!canSaveCache) return;
    const nextCache: SakaiCache = {
      version: "v1", semester, pdfs: [...cached.values()].sort((a, b) => a.url.localeCompare(b.url)),
      pending: [...pending].sort((a, b) => Number(failedDownloads.has(a)) - Number(failedDownloads.has(b))),
    };
    const content = JSON.stringify(nextCache);
    if (content === expectedCache || (expectedCache === null && !nextCache.pdfs.length && !nextCache.pending.length)) return;
    try {
      readCache(content, semester);
      const dir = await checked(() => join(root, ".mci-manager"));
      await checked(() => apiEnsureDir(dir));
      await checked(() => apiSaveText(cachePath, content, expectedCache));
      expectedCache = content;
    } catch (error) {
      if (sakaiSessionError(error)) throw error;
      canSaveCache = false;
      report.warnings.push("Der Sakai-Cache konnte nicht sicher gespeichert werden; vorhandene Cache-Daten bleiben erhalten.");
    }
  };
  const studyDir = await checked(() => join(root, "Studium"));
  const entries = await checked(() => apiListDocs(studyDir));
  const sourceDir = await checked(() => join(root, "Studium", "Quellen"));
  let existingPdfs = new Set<string>();
  try {
    const sources = await checked(() => apiListDocs(sourceDir));
    existingPdfs = new Set(sources.map(({ name }) => `Studium/Quellen/${name}`).filter((path) => SAKAI_PDF_PATH.test(path)));
  } catch (error) {
    if (sakaiSessionError(error)) throw error;
    report.warnings.push("Vorhandene Sakai-PDFs konnten nicht geprüft werden; der native Download prüft den sicheren Zugriff erneut.");
  }
  let attempts = 0;
  let bytes = 0;
  for (const [index, group] of groups.entries()) {
    current();
    const groupLabel = group.subject?.name ?? group.siteIds.join(", ");
    options.onProgress(`${groupLabel} (${index + 1} von ${groups.length}) wird abgerufen.`);
    current();
    let activeSiteId: string | null = null;
    try {
      const snapshots: SakaiSnapshot[] = [];
      for (const siteId of group.siteIds) {
        activeSiteId = siteId;
        const snapshot = await checked(() => apiSakaiSnapshot(siteId));
        if (snapshot.warnings.length) throw new Error("Unvollständiger Sakai-Abruf.");
        snapshots.push(snapshot);
      }
      activeSiteId = null;
      const title = group.subject?.name ?? snapshots[0].site.title;
      const identity = JSON.stringify(["v1", semester, group.subjectKey === null ? ["site", group.siteIds[0]] : ["subject", group.subjectKey]]);
      const groupHash = await checked(() => sakaiHash(identity));
      const candidates = entries.filter(({ name }) => /^Sakai(?: Live)? - /.test(name) && name.endsWith(` - ${groupHash}.md`));
      if (candidates.length > 1) throw new Error("CONFLICT");
      const relative = candidates.length ? knowledgePath(`Studium/${candidates[0].name}`) : sakaiNotePath(title, semester, groupHash);
      if (relative.split("/").length !== 2) throw new Error("CONFLICT");
      const path = await checked(() => join(root, relative));
      const expected = await checked(() => apiReadText(path));
      const suffix = await checked(() => personalSuffix(expected, semester, group, checked));
      const targets = [{ path: `${semester}/_Semester.md`, label: semester }];
      if (group.subject) {
        const file = group.subject.file ?? subjectFileName(group.subject.name);
        validateRelativePath(group.subject.dir, 1);
        validateNoteFile(file);
        targets.push({ path: knowledgePath(`${semester}/${group.subject.dir}/${file}`), label: group.subject.name });
      } else {
        targets.push({ path: "Studium/Studienwissen.md", label: "Studienwissen" });
      }
      const navigation = [];
      for (const target of targets) {
        const targetPath = await checked(() => join(root, target.path));
        if (await checked(() => apiReadText(targetPath)) !== null) navigation.push(target);
      }
      const pdfs = new Map<string, string>();
      let pendingPdfs = 0;
      const resources = snapshots.flatMap((snapshot) => snapshot.resources.map((resource) => ({ siteId: snapshot.site.id, resource })))
        .sort((a, b) => (priority.get(a.resource.url) ?? Infinity) - (priority.get(b.resource.url) ?? Infinity)
          || a.resource.url.localeCompare(b.resource.url));
      for (const { siteId, resource } of resources) {
        current();
        if (!sourceUrl(resource.url)) {
          report.warnings.push("Ein unsicherer Ressourcenlink wurde ausgelassen.");
          continue;
        }
        if (!isPdf(resource)) continue;
        const url = sourceUrl(resource.url)!;
        if (!resourceUrl(url) || sakaiSourceSite(url) !== siteId || new URL(url).origin !== SAKAI_ORIGIN) {
          pendingPdfs++;
          externalPdfs.add(url);
          continue;
        }
        if (resource.size <= 0 || resource.size > MAX_SAKAI_PDF_BYTES) {
          pendingPdfs++;
          oversizedPdfs.add(url);
          continue;
        }
        const downloadedPdf = downloaded.get(url);
        if (downloadedPdf) {
          pdfs.set(resource.url, downloadedPdf.path);
          continue;
        }
        const previous = cached.get(url);
        if (previous && previous.size === resource.size && previous.modifiedDate === resource.modifiedDate
          && resource.modifiedDate !== null && existingPdfs.has(previous.path)) {
          pdfs.set(resource.url, previous.path);
          pending.delete(url);
          continue;
        }
        if (failedDownloads.has(url)) {
          pendingPdfs++;
          continue;
        }
        if (attempts >= MAX_SAKAI_BATCH_PDFS || MAX_SAKAI_PDF_BYTES > MAX_SAKAI_BATCH_BYTES - bytes) {
          await saveCache();
          attempts = 0;
          bytes = 0;
        }
        attempts++;
        const maxBytes = MAX_SAKAI_PDF_BYTES;
        // Failed requests retain their reservation; only verified native byte counts release it.
        bytes += maxBytes;
        options.onProgress(`${title}: ${report.downloaded} PDFs gespeichert. Nächste PDF wird geladen …`);
        try {
          const local = await checked(() => invoke<unknown>("sakai_download_pdf", { root, siteId, url, maxBytes }));
          if (!keys(local, ["path", "bytes"]) || typeof local.path !== "string" || !SAKAI_PDF_PATH.test(local.path)
            || typeof local.bytes !== "number" || !Number.isSafeInteger(local.bytes) || local.bytes <= 0 || local.bytes > maxBytes) {
            throw new Error("Ungültiges lokales PDF-Ergebnis.");
          }
          bytes -= maxBytes - local.bytes;
          const entry = { url, modifiedDate: resource.modifiedDate, size: resource.size, path: local.path };
          downloaded.set(url, entry);
          cached.set(url, entry);
          pending.delete(url);
          pdfs.set(resource.url, local.path);
          report.downloaded++;
        } catch (error) {
          if (sakaiSessionError(error)) throw error;
          if (previous && previous.size === resource.size && previous.modifiedDate === resource.modifiedDate && existingPdfs.has(previous.path)) {
            pdfs.set(resource.url, previous.path);
          }
          pendingPdfs++;
          pending.add(url);
          failedDownloads.add(url);
        }
      }
      const prefix = sakaiGeneratedPrefix(semester, group.subjectKey, title, date, snapshots, pdfs, pendingPdfs, navigation);
      const prefixHash = await checked(() => sakaiHash(prefix));
      const content = `${prefix}<!-- sm:sakai:${prefixHash} -->${suffix}`;
      if (new TextEncoder().encode(content).length > MAX_KNOWLEDGE_BYTES) throw new Error("Sakai-Notiz ist zu groß.");
      if (content === expected) { report.unchanged++; continue; }
      await checked(() => apiEnsureDir(studyDir));
      await checked(() => apiSaveText(path, content, expected));
      report.updated++;
    } catch (error) {
      const session = sakaiSessionError(error);
      if (session) throw new Error(session);
      if (group.subjectKey !== null) (report.failedSubjectKeys ??= []).push(group.subjectKey);
      const failure = activeSiteId === null ? null : snapshotFailure(error);
      report.warnings.push(failure
        ? `${groupLabel}: ${failure} (${activeSiteId}); die vorhandene Notiz bleibt unverändert.`
        : isConflictError(error)
        ? `${groupLabel}: Bearbeitungskonflikt; die vorhandene Notiz bleibt unverändert.`
        : `${groupLabel}: Der Abruf oder sichere Schreibzugriff ist fehlgeschlagen; die vorhandene Notiz bleibt unverändert.`);
    }
  }
  for (const [urls, reason] of [
    [externalPdfs, "Außerhalb der gewählten Sakai-Site; nur als HTTPS-Link verfügbar."],
    [oversizedPdfs, "Dateigröße unbekannt oder über 15 MiB; nur als Link verfügbar."],
    [failedDownloads, "Download fehlgeschlagen; bleibt für einen erneuten Abruf vorgemerkt. Quellenlinks bleiben verfügbar."],
  ] as const) {
    if (urls.size) report.warnings.push(`${urls.size} ${urls.size === 1 ? "PDF" : "PDFs"}: ${reason}`);
  }
  await saveCache();
  current();
  report.completedAt = new Date().toISOString();
  return report;
}
