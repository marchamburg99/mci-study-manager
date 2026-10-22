import { invoke } from "@tauri-apps/api/core";
import { homeDir, join } from "@tauri-apps/api/path";
import type { AppConfig, StudyEvent } from "./types";
import { DEFAULT_CONFIG } from "./types";
import { buildFaecher, subjectName } from "./ical";
import { normalizeCalendarUrl, validateConfig } from "./config";
import { assignEventPaths, ownsIndexedNote, readIndex, validateNoteFile, validateRelativePath } from "./identity";
import { subjectFileName } from "./filenames";
import {
  MOC_END,
  MOC_START,
  OBSIDIAN_APP_JSON,
  TERMIN_TEMPLATE_MD,
  buildFachMoc,
  buildSemesterMoc,
  buildTerminNote,
  buildVaultReadme,
  fachTerminRows,
  parseNote,
  readStatus,
  refreshGeneratedFachQuery,
  replaceBetweenMarkers,
  semesterFachRows,
  serializeNote,
  writeStatus,
} from "./notes";

export interface DocEntry {
  name: string;
  path: string;
  size: number;
}

const LS_KEY = "mci-manager-config-v1";

export async function defaultBasis(): Promise<string> {
  try {
    return await join(await homeDir(), "MCI");
  } catch {
    return "";
  }
}

export async function loadConfig(): Promise<AppConfig> {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const value: unknown = JSON.parse(raw);
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Ungültige Einstellungen.");
      const fields = value as Record<string, unknown>;
      for (const key of ["icalUrl", "basisPfad", "semester"] as const) {
        if (key in fields && typeof fields[key] !== "string") throw new Error("Ungültige Einstellungen.");
      }
      if (("refreshHours" in fields && typeof fields.refreshHours !== "number")
        || ("lastRefresh" in fields && fields.lastRefresh !== null && typeof fields.lastRefresh !== "string")) {
        throw new Error("Ungültige Einstellungen.");
      }
      return validateConfig({
        icalUrl: typeof fields.icalUrl === "string" ? fields.icalUrl : DEFAULT_CONFIG.icalUrl,
        basisPfad: typeof fields.basisPfad === "string" ? fields.basisPfad : await defaultBasis(),
        semester: typeof fields.semester === "string" ? fields.semester : DEFAULT_CONFIG.semester,
        refreshHours: typeof fields.refreshHours === "number" ? fields.refreshHours : DEFAULT_CONFIG.refreshHours,
        lastRefresh: typeof fields.lastRefresh === "string" ? fields.lastRefresh : null,
      });
    }
  } catch {
    throw new Error("Die gespeicherten Einstellungen sind nicht lesbar oder ungültig. Bitte in den Einstellungen prüfen und erneut speichern.");
  }
  return { ...DEFAULT_CONFIG, basisPfad: await defaultBasis() };
}

export function saveConfig(cfg: AppConfig): void {
  localStorage.setItem(LS_KEY, JSON.stringify(cfg));
}

export async function semesterRoot(cfg: AppConfig): Promise<string> {
  validateRelativePath(cfg.semester, 1);
  return join(cfg.basisPfad, cfg.semester);
}

export async function managerDir(cfg: AppConfig): Promise<string> {
  return join(cfg.basisPfad, ".mci-manager");
}

export async function calendarCachePath(cfg: AppConfig): Promise<string> {
  validateRelativePath(cfg.semester, 1);
  const source = JSON.stringify([normalizeCalendarUrl(cfg.icalUrl), cfg.semester]);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source));
  const key = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return join(await managerDir(cfg), `calendar-${key}.ics`);
}

export async function terminDir(cfg: AppConfig, terminRel: string): Promise<string> {
  validateRelativePath(terminRel, 2);
  return join(await semesterRoot(cfg), terminRel);
}

export async function docsDir(cfg: AppConfig, terminRel: string): Promise<string> {
  return join(await terminDir(cfg, terminRel), "docs");
}

export async function notesPath(cfg: AppConfig, terminRel: string): Promise<string> {
  validateRelativePath(terminRel, 2);
  const index = readIndex(await apiReadText(await join(await semesterRoot(cfg), ".mci-manager", "event-paths.json")));
  return join(await terminDir(cfg, terminRel), index.files[terminRel] ?? "notes.md");
}

async function readTerminSnapshot(cfg: AppConfig, terminRel: string) {
  validateRelativePath(terminRel, 2);
  const indexPath = await join(await semesterRoot(cfg), ".mci-manager", "event-paths.json");
  const rawIndex = await apiReadText(indexPath);
  const index = readIndex(rawIndex);
  const fileName = index.files[terminRel] ?? "notes.md";
  const path = await join(await terminDir(cfg, terminRel), fileName);
  return { index, indexPath, rawIndex, fileName, path, raw: await apiReadText(path) };
}

export async function readEditorNote(cfg: AppConfig, event: { uid: string; terminRel: string }): Promise<string | null> {
  const snapshot = await readTerminSnapshot(cfg, event.terminRel);
  return snapshot.raw === "" && ownsIndexedNote(snapshot.index, event.uid, event.terminRel, snapshot.fileName)
    ? null : snapshot.raw;
}

// --- Rust-Commands (Typsicherheit über explizite Args) ---

export const apiFetchIcal = (url: string): Promise<string> =>
  invoke<string>("fetch_ical", { url });

export const apiSetVaultRoot = (path: string): Promise<void> =>
  invoke("set_vault_root", { path });

export const apiChooseVaultRoot = (): Promise<string | null> =>
  invoke<string | null>("choose_vault_root");

export const apiOpenVaultFile = (path: string): Promise<void> =>
  invoke("open_vault_file", { path });

export const apiRevealVaultPath = (path: string): Promise<void> =>
  invoke("reveal_vault_path", { path });

export const apiOpenExternalUrl = (url: string): Promise<void> =>
  invoke("open_external_url", { url });

export const apiPickDocuments = (): Promise<string[]> =>
  invoke<string[]>("pick_documents");

export const apiEnsureDir = (path: string): Promise<void> =>
  invoke("ensure_dir", { path });

export async function apiSaveText(path: string, content: string, expected: string | null): Promise<void> {
  if (expected !== null && typeof expected !== "string") {
    throw new Error("Der gelesene Dateistand fehlt für den sicheren Schreibzugriff.");
  }
  await invoke("save_text_file", { path, content, expected });
}

export const apiReadText = (path: string): Promise<string | null> =>
  invoke<string | null>("read_text_file", { path });

export function isConflictError(error: unknown): boolean {
  return error === "CONFLICT" || (error instanceof Error && error.message === "CONFLICT");
}

export async function resolveEventPaths(cfg: AppConfig, events: StudyEvent[]): Promise<StudyEvent[]> {
  const root = await semesterRoot(cfg);
  const path = await join(root, ".mci-manager", "event-paths.json");
  const expected = await apiReadText(path);
  const index = readIndex(expected);
  const notes = await invoke<Array<{ path: string; content: string }>>("discover_notes", { dir: root });
  const prefix = `${root.replace(/\\/g, "/").replace(/\/+$/, "")}/`;
  const discovered = notes.flatMap((note) => {
    const fullPath = note.path.replace(/\\/g, "/");
    if (!fullPath.startsWith(prefix) || !fullPath.endsWith(".md")) {
      throw new Error("Eine gefundene Notiz liegt außerhalb des Semesterordners.");
    }
    const relative = fullPath.slice(prefix.length);
    const terminRel = relative.slice(0, relative.lastIndexOf("/"));
    const fileName = relative.slice(relative.lastIndexOf("/") + 1);
    validateRelativePath(terminRel, 2);
    if (fileName !== "notes.md" && index.files[terminRel] !== fileName) {
      try {
        const uid = parseNote(note.content).data.uid;
        if (typeof uid !== "string" || !uid.trim()) return [];
      } catch { return []; }
    }
    return [{ terminRel, content: note.content, fileName }];
  });
  const result = assignEventPaths(expected, discovered, events);
  if (result.raw !== expected) {
    await apiEnsureDir(await join(root, ".mci-manager"));
    await apiSaveText(path, result.raw, expected);
  }
  return result.events;
}

export const apiCopyInto = (src: string, destDir: string): Promise<string> =>
  invoke<string>("copy_file_into", { src, destDir });

export const apiListDocs = (dir: string): Promise<DocEntry[]> =>
  invoke<DocEntry[]>("list_docs", { dir });

export const apiDeleteFile = (path: string): Promise<void> =>
  invoke("delete_file", { path });

async function metaPath(cfg: AppConfig, terminRel: string): Promise<string> {
  return join(await terminDir(cfg, terminRel), "meta.json");
}

// --- notes.md: Frontmatter ist die einzige Wahrheit -------------------
// meta.json war der Vorgänger — wird beim Öffnen einmalig migriert und
// danach gelöscht. Status-Regel (siehe notes.ts): Alle Tasks der Sektion
// abgehakt ⟺ Status true; ohne Tasks gilt das Frontmatter-Flag.

export function semesterTag(cfg: AppConfig): string {
  const seg = cfg.semester.toLowerCase().replace(/_/g, "-").split("-").find((p) => /^sem\d+$/.test(p));
  return `mci/${seg ?? cfg.semester.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")}`;
}

export function fachTag(fachKey: string): string {
  return `fach/${fachKey}`;
}

export async function readTerminNote(
  cfg: AppConfig,
  terminRel: string,
): Promise<{ data: Record<string, unknown>; body: string; raw: string } | null> {
  const raw = await apiReadText(await notesPath(cfg, terminRel));
  return raw === null ? null : { ...parseNote(raw), raw };
}

export async function saveTerminNote(
  cfg: AppConfig,
  terminRel: string,
  data: Record<string, unknown>,
  body: string,
  expected: string | null,
): Promise<string> {
  const previous = expected === null ? null : parseNote(expected);
  if (previous && previous.data.uid !== data.uid) {
    throw new Error("Die Notiz gehört zu einer anderen Termin-UID.");
  }
  const normalized = { ...previous?.data, ...data, ...readStatus(data, body) };
  const raw = serializeNote(normalized, body);
  parseNote(raw);
  await apiSaveText(await notesPath(cfg, terminRel), raw, expected);
  return raw;
}

/** Stellt sicher, dass Termin-Ordner + notes.md existieren (inkl. Migration). */
export async function ensureTermin(
  cfg: AppConfig,
  ev: {
    uid: string;
    summary: string;
    fach: string;
    typ: string;
    start: string;
    end: string;
    dozent: string;
    lvNummer: string;
    fachKey: string;
    terminRel: string;
    subjectDir?: string;
    subjectFile?: string;
  },
): Promise<{
  data: Record<string, unknown>;
  body: string;
  status: { vorbereitet: boolean; nachbereitet: boolean };
  raw: string;
}> {
  const snapshot = await readTerminSnapshot(cfg, ev.terminRel);
  const placeholder = snapshot.raw === "" && ownsIndexedNote(snapshot.index, ev.uid, ev.terminRel, snapshot.fileName);
  const existing = snapshot.raw === null || placeholder ? null : { ...parseNote(snapshot.raw), raw: snapshot.raw };
  if (!ev.uid || (existing && existing.data.uid !== ev.uid)) {
    throw new Error("Die Notiz gehört zu einer anderen Termin-UID.");
  }
  const legacyPath = await metaPath(cfg, ev.terminRel);
  const rawMeta = await apiReadText(legacyPath);
  let note = existing;
  if (note === null) {
    const index = snapshot.index;
    const subjectDir = index.subjects[ev.fachKey] ?? ev.subjectDir ?? ev.terminRel.split("/")[0];
    const subjectFile = index.subjectFiles[ev.fachKey] ?? ev.subjectFile ?? subjectFileName(subjectName(ev.fach));
    validateRelativePath(subjectDir, 1);
    validateNoteFile(subjectFile);
    const raw = buildTerminNote({
      fach: ev.fach,
      typ: ev.typ,
      summary: ev.summary,
      start: ev.start,
      end: ev.end,
      dozent: ev.dozent,
      uid: ev.uid,
      lv: ev.lvNummer,
      fachTag: fachTag(ev.fachKey),
      semesterTag: semesterTag(cfg),
      fachPath: `${cfg.semester}/${subjectDir}/${subjectFile}`,
    });
    note = { ...parseNote(raw), raw };
  }

  let { data, body } = note;
  let touched = existing === null;
  let migrated = false;

  // Malformed metadata stays recoverable; trash only after a checked note write.
  if (rawMeta !== null) {
    try {
      const meta: unknown = JSON.parse(rawMeta);
      if (meta && typeof meta === "object" && !Array.isArray(meta)) {
        const fields = meta as Record<string, unknown>;
        const keys = ["vorbereitet", "nachbereitet"] as const;
        if (keys.some((key) => typeof fields[key] === "boolean")
          && keys.every((key) => !(key in fields) || typeof fields[key] === "boolean")
          && (!("uid" in fields) || fields.uid === ev.uid)) {
          for (const key of keys) {
            if (fields[key] === true) ({ data, body } = writeStatus(data, body, key, true));
          }
          migrated = true;
          touched = true;
        }
      }
    } catch {
      // Leave invalid JSON untouched.
    }
  }

  // Frontmatter-Flags auf den Task-Stand normalisieren (für Dataview-Abfragen).
  const status = readStatus(data, body);
  if (data["vorbereitet"] !== status.vorbereitet || data["nachbereitet"] !== status.nachbereitet) {
    data = { ...data, vorbereitet: status.vorbereitet, nachbereitet: status.nachbereitet };
    touched = true;
  }
  await apiEnsureDir(await terminDir(cfg, ev.terminRel));
  await apiEnsureDir(await docsDir(cfg, ev.terminRel));
  let raw = note.raw;
  if (placeholder) {
    raw = serializeNote({ ...data, ...status }, body);
    parseNote(raw);
    if (await apiReadText(snapshot.indexPath) !== snapshot.rawIndex) throw "CONFLICT";
    await apiSaveText(snapshot.path, raw, snapshot.raw);
  } else if (touched) {
    raw = await saveTerminNote(cfg, ev.terminRel, data, body, existing?.raw ?? null);
  }
  if (migrated && await apiReadText(legacyPath) === rawMeta) await apiDeleteFile(legacyPath);
  return { ...parseNote(raw), status, raw };
}

/** App-seitiges Toggeln: schreibt Flag + Sektions-Tasks, speichert sofort. */export async function setTerminStatus(
  cfg: AppConfig,
  terminRel: string,
  data: Record<string, unknown>,
  body: string,
  key: "vorbereitet" | "nachbereitet",
  value: boolean,
  expected: string | null,
): Promise<{ data: Record<string, unknown>; body: string; raw: string }> {
  const next = writeStatus(data, body, key, value);
  const raw = await saveTerminNote(cfg, terminRel, next.data, next.body, expected);
  return { ...parseNote(raw), raw };
}

/** Lesender Status-Blick ohne Ordner-Anlage: fehlt die Note, gilt offen.
 *  Für Übersichten (Vorbereiten-Tab) — Anlegen bleibt der Fachansicht vorbehalten. */
export async function peekStatus(
  cfg: AppConfig,
  terminRel: string,
): Promise<{ vorbereitet: boolean; nachbereitet: boolean }> {
  const raw = await apiReadText(await notesPath(cfg, terminRel));
  if (raw === null) return { vorbereitet: false, nachbereitet: false };
  const { data, body } = parseNote(raw);
  return readStatus(data, body);
}

// --- Vault-Gerüst: MOCs, Templates, Obsidian-Config --------------------
// Nur generierte Listen und bekannte Fach-Standardqueries werden aktualisiert.
// Nutzer-Abschnitte (Offene Fragen, Prüfungsthemen) bleiben unangetastet.

async function writeIfMissing(path: string, content: string): Promise<void> {
  if ((await apiReadText(path)) === null) await apiSaveText(path, content, null);
}

async function upsertMocBlock(path: string, full: string, rows: string, fach?: {
  fach: string;
  lvNummern: string[];
  semesterPath: string;
}): Promise<void> {
  const cur = await apiReadText(path);
  if (cur === null) {
    await apiSaveText(path, full, null);
    return;
  }
  if (!cur.includes(MOC_START) || !cur.includes(MOC_END)) return; // fremde Datei
  const { text } = replaceBetweenMarkers(cur, rows);
  const next = fach ? refreshGeneratedFachQuery(text, fach) : text;
  if (next !== cur) await apiSaveText(path, next, cur);
}

/** Baut/aktualisiert Vault-Root, Templates, Semester- und Fach-MOCs. */
export async function ensureVault(cfg: AppConfig, events: StudyEvent[]): Promise<void> {
  if (!cfg.basisPfad) return;
  for (const event of events) {
    validateRelativePath(event.fachDir, 1);
    validateRelativePath(event.terminRel, 2);
    if (!event.terminRel.startsWith(`${event.fachDir}/`)) throw new Error("Der Terminpfad passt nicht zum Fachordner.");
  }
  const semesterPath = cfg.semester;
  const semDir = await semesterRoot(cfg);
  const stag = semesterTag(cfg);
  const faecher = buildFaecher(events);
  const byKey = new Map<string, StudyEvent[]>();
  for (const e of events) {
    if (!byKey.has(e.fachKey)) byKey.set(e.fachKey, []);
    byKey.get(e.fachKey)!.push(e);
  }

  await writeIfMissing(await join(cfg.basisPfad, ".obsidian", "app.json"), OBSIDIAN_APP_JSON);
  await writeIfMissing(await join(cfg.basisPfad, "00-system", "templates", "termin.md"), TERMIN_TEMPLATE_MD);
  await writeIfMissing(await join(cfg.basisPfad, "README.md"), buildVaultReadme({ semesterPath, semesterTag: stag }));
  await apiEnsureDir(semDir);

  await upsertMocBlock(
    await join(semDir, "_Semester.md"),
    buildSemesterMoc({ semesterPath, semesterTag: stag, faecher }),
    semesterFachRows(semesterPath, faecher),
  );

  for (const f of faecher) {
    const evs = byKey.get(f.key) ?? [];
    const rep = evs[0];
    const lvNummern = evs.map((e) => e.lvNummer);
    await apiEnsureDir(await join(semDir, f.dir));
    await upsertMocBlock(
      await join(semDir, f.dir, f.file ?? subjectFileName(f.name)),
      buildFachMoc({
        fach: f.name,
        typ: f.types.join(" / "),
        dozent: f.dozent,
        lvBeispiel: rep?.lvNummer ?? "",
        lvNummern,
        fachDir: f.dir,
        semesterPath,
        fachTag: fachTag(f.key),
        semesterTag: stag,
        termine: evs.map((e) => ({ start: e.start, terminRel: e.terminRel, summary: e.summary, noteFile: e.noteFile })),
      }),
      fachTerminRows(evs, semesterPath),
      { fach: f.name, lvNummern, semesterPath },
    );
  }
}
