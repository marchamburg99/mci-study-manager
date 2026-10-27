import { folderKey, folderTitle, slug } from "./ical.ts";
import { isSafeRelativePath, parseNote, toLocalDateKey, toLocalTimeKey } from "./notes.ts";
import type { StudyEvent } from "./types";
import { appointmentFileName, subjectFileName } from "./filenames.ts";

export interface PathIndex {
  version: 2;
  paths: Record<string, string>;
  subjects: Record<string, string>;
  reserved: string[];
  files: Record<string, string>;
  subjectFiles: Record<string, string>;
}

export function validateRelativePath(path: string, depth: number): void {
  if (!isSafeRelativePath(path) || path.split("/").length !== depth
    || path.split("/").some((part) => part.startsWith(".") || part !== part.trim() || part.endsWith("."))) {
    throw new Error("Ungültiger relativer Vault-Pfad.");
  }
}

function pathKey(path: string): string {
  return path.normalize("NFC").toLowerCase();
}

export function ownsIndexedNote(index: PathIndex, uid: string, terminRel: string, fileName: string): boolean {
  return index.paths[uid] === terminRel && index.files[terminRel] === fileName
    && Object.entries(index.paths).every(([owner, path]) => owner === uid || pathKey(path) !== pathKey(terminRel));
}

function folderStem(event: StudyEvent): string {
  const name = slug(event.fach);
  const type = slug(event.typ);
  return name === type || name.endsWith(`-${type}`) ? name : slug(`${event.fach} ${event.typ}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === "string");
}

export function validateNoteFile(file: string): void {
  validateRelativePath(file, 1);
  if (!file.endsWith(".md") || /[[\]#|^%?*"<>]/.test(file)) throw new Error("Ungültiger Notizdateiname.");
}

export function readIndex(raw: string | null): PathIndex {
  if (raw === null) return { version: 2, paths: {}, subjects: {}, reserved: [], files: {}, subjectFiles: {} };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("Der Terminpfad-Index enthält ungültiges JSON.");
  }
  if (!isRecord(value) || (value.version !== 1 && value.version !== 2) || !stringRecord(value.paths)
    || !stringRecord(value.subjects) || !Array.isArray(value.reserved)
    || !value.reserved.every((path): path is string => typeof path === "string")
    || (value.version === 2 && (!stringRecord(value.files) || !stringRecord(value.subjectFiles)))) {
    throw new Error("Der Terminpfad-Index hat ein unbekanntes oder beschädigtes Format.");
  }
  for (const [uid, path] of Object.entries(value.paths)) {
    if (!uid.trim()) throw new Error("Im Terminpfad-Index fehlt eine UID.");
    validateRelativePath(path, 2);
  }
  for (const [key, path] of Object.entries(value.subjects)) {
    validateRelativePath(key, 1);
    validateRelativePath(path, 1);
  }
  for (const path of value.reserved) validateRelativePath(path, 2);
  const files = value.version === 2 && stringRecord(value.files) ? value.files : {};
  const subjectFiles = value.version === 2 && stringRecord(value.subjectFiles) ? value.subjectFiles : {};
  for (const [path, file] of Object.entries(files)) {
    validateRelativePath(path, 2);
    validateNoteFile(file);
  }
  for (const [key, file] of Object.entries(subjectFiles)) {
    validateRelativePath(key, 1);
    validateNoteFile(file);
  }
  return { version: 2, paths: value.paths, subjects: value.subjects, reserved: value.reserved, files, subjectFiles };
}

function noteSubject(data: Record<string, unknown>): string | undefined {
  const tags = Array.isArray(data.tags) ? data.tags : typeof data.tags === "string" ? [data.tags] : [];
  const keys = tags.filter((tag): tag is string => typeof tag === "string" && tag.startsWith("fach/"));
  if (keys.length > 1) throw new Error("Die Notiz enthält mehrere Fachzuordnungen.");
  if (keys.length === 1) {
    const key = keys[0].slice("fach/".length);
    validateRelativePath(key, 1);
    return key;
  }
  if (typeof data.fach !== "string" || typeof data.typ !== "string") return undefined;
  const fach = slug(data.fach);
  const typ = slug(data.typ);
  return fach === typ || fach.endsWith(`-${typ}`) ? fach : slug(`${data.fach} ${data.typ}`);
}

/**
 * `folder` gives every subject and course type its own folder and overview note (current app).
 * `subject` keeps one folder per subject; the legacy notes.md migration plans with it.
 */
export type FolderLayout = "folder" | "subject";

export function assignEventPaths(
  rawIndex: string | null,
  notes: Array<{ terminRel: string; content: string; fileName?: string }>,
  events: StudyEvent[],
  layout: FolderLayout = "folder",
): { events: StudyEvent[]; raw: string } {
  const keyOf = (event: StudyEvent) => layout === "folder" ? folderKey(event) : event.fachKey;
  const titleOf = (event: StudyEvent) => layout === "folder" ? folderTitle(event.fach, event.typ) : event.fach;
  const stemOf = (event: StudyEvent) => layout === "folder" ? folderStem(event) : slug(event.fach);
  const index = readIndex(rawIndex);
  const paths = new Map(Object.entries(index.paths));
  const subjects = new Map(Object.entries(index.subjects));
  const files = new Map(Object.entries(index.files));
  const subjectFiles = new Map(Object.entries(index.subjectFiles));
  const reserved = new Map(index.reserved.map((path) => [pathKey(path), path]));
  const owners = new Map<string, string>();
  const byUid = new Map<string, StudyEvent>();

  for (const event of events) {
    if (!event.uid.trim()) throw new Error("Ein Kalendertermin hat keine UID.");
    if (byUid.has(event.uid)) throw new Error("Der Kalender enthält eine doppelte Termin-UID.");
    validateRelativePath(event.fachKey, 1);
    if (!Number.isFinite(Date.parse(event.start))) throw new Error("Ein Kalendertermin hat ein ungültiges Datum.");
    byUid.set(event.uid, event);
  }

  const claim = (uid: string, path: string) => {
    const key = pathKey(path);
    const owner = owners.get(key);
    const previous = paths.get(uid);
    if ((owner !== undefined && owner !== uid) || (previous !== undefined && previous !== path)) {
      throw new Error("Widersprüchliche UID-Zuordnung: Ein Terminpfad gehört bereits zu einer anderen Notiz.");
    }
    owners.set(key, uid);
    paths.set(uid, path);
    reserved.set(key, path);
  };
  for (const [uid, path] of paths) claim(uid, path);

  const discovered = new Set<string>();
  for (const note of [...notes].sort((a, b) => a.terminRel.localeCompare(b.terminRel))) {
    validateRelativePath(note.terminRel, 2);
    const path = pathKey(note.terminRel);
    if (discovered.has(path)) throw new Error("Ein Notizpfad wurde mehrfach gefunden.");
    discovered.add(path);
    reserved.set(path, note.terminRel);
    const file = note.fileName ?? "notes.md";
    validateNoteFile(file);
    const owner = owners.get(path);
    if (note.content === "" && owner !== undefined && ownsIndexedNote(index, owner, note.terminRel, file)) continue;
    const { data } = parseNote(note.content);
    if (typeof data.uid !== "string" || !data.uid.trim()) {
      if (owner !== undefined) throw new Error(`Die UID einer zugeordneten Notiz fehlt oder ist ungültig: ${note.terminRel}/${file}`);
      files.set(note.terminRel, file);
      continue;
    }
    claim(data.uid, note.terminRel);
    if (files.has(note.terminRel) && files.get(note.terminRel) !== file) {
      throw new Error("Der Notizdateiname widerspricht dem Terminpfad-Index.");
    }
    files.set(note.terminRel, file);
    const legacyKey = noteSubject(data);
    const event = byUid.get(data.uid);
    const key = event ? keyOf(event) : legacyKey;
    if (key && !subjects.has(key)) subjects.set(key, note.terminRel.split("/")[0]);
  }

  // A subject taught in only one course type keeps its folder and overview from the
  // earlier per-subject layout; the legacy entry moves so no second overview appears.
  if (layout === "folder") {
    const types = new Map<string, Set<string>>();
    for (const event of events) types.set(event.fachKey, (types.get(event.fachKey) ?? new Set()).add(event.typ));
    for (const event of events) {
      const key = keyOf(event);
      const legacyDir = subjects.get(event.fachKey);
      if (key === event.fachKey || types.get(event.fachKey)!.size !== 1 || legacyDir === undefined) continue;
      if (!subjects.has(key)) subjects.set(key, legacyDir);
      const legacyFile = subjectFiles.get(event.fachKey);
      if (subjects.get(key) === legacyDir && legacyFile !== undefined && !subjectFiles.has(key)) subjectFiles.set(key, legacyFile);
      if (subjects.get(key) === legacyDir) {
        subjects.delete(event.fachKey);
        subjectFiles.delete(event.fachKey);
      }
    }
  }

  // Adopt every known UID before allocating folders for newly introduced subjects.
  for (const event of events) {
    const path = paths.get(event.uid);
    if (path && !subjects.has(keyOf(event))) subjects.set(keyOf(event), path.split("/")[0]);
  }
  const dirs = new Set([...subjects.values(), ...[...reserved.values()].map((path) => path.split("/")[0])].map(pathKey));
  let nextNumber = Math.max(0, ...[...dirs].map((dir) => Number(dir.match(/^(\d+)-/)?.[1] ?? 0))) + 1;
  for (const event of [...events].sort((a, b) => keyOf(a).localeCompare(keyOf(b)) || a.uid.localeCompare(b.uid))) {
    if (subjects.has(keyOf(event))) continue;
    const readableKey = stemOf(event) || "fach";
    let dir: string;
    do {
      dir = `${String(nextNumber++).padStart(2, "0")}-${readableKey}`;
    } while (dirs.has(pathKey(dir)));
    validateRelativePath(dir, 1);
    subjects.set(keyOf(event), dir);
    dirs.add(pathKey(dir));
  }

  for (const event of [...events].sort((a, b) => a.start.localeCompare(b.start) || a.uid.localeCompare(b.uid))) {
    if (paths.has(event.uid)) continue;
    const base = `${subjects.get(keyOf(event))!}/${toLocalDateKey(event.start)}_${folderStem(event)}`;
    let path = base;
    if (reserved.has(pathKey(path))) path = `${base}-${toLocalTimeKey(event.start)}`;
    const timed = path;
    let suffix = 2;
    while (reserved.has(pathKey(path))) path = `${timed}-${suffix++}`;
    validateRelativePath(path, 2);
    claim(event.uid, path);
  }

  const occupiedMocs = new Map<string, string>();
  for (const [key, file] of subjectFiles) {
    const dir = subjects.get(key);
    if (!dir) throw new Error("Der Fachdatei fehlt ein zugeordneter Ordner.");
    const target = pathKey(`${dir}/${file}`);
    if (occupiedMocs.has(target)) throw new Error("Mehrere Fächer sind derselben Fachdatei zugeordnet.");
    occupiedMocs.set(target, key);
  }
  for (const event of [...events].sort((a, b) => keyOf(a).localeCompare(keyOf(b)))) {
    const key = keyOf(event);
    const path = paths.get(event.uid)!;
    if (!files.has(path)) files.set(path, appointmentFileName(event.fach, toLocalDateKey(event.start), toLocalTimeKey(event.start)));
    if (!subjectFiles.has(key)) {
      const base = subjectFileName(titleOf(event));
      let file = base;
      let suffix = 2;
      const dir = subjects.get(key)!;
      while (occupiedMocs.has(pathKey(`${dir}/${file}`))) file = `${base.slice(0, -3)} (${suffix++}).md`;
      subjectFiles.set(key, file);
      occupiedMocs.set(pathKey(`${dir}/${file}`), key);
    }
  }

  const sorted = (values: Map<string, string>) => Object.fromEntries([...values].sort(([a], [b]) => a.localeCompare(b)));
  const next: PathIndex = {
    version: 2,
    paths: sorted(paths),
    subjects: sorted(subjects),
    reserved: [...reserved.values()].sort(),
    files: sorted(files),
    subjectFiles: sorted(subjectFiles),
  };
  return {
    events: events.map((event) => {
      const terminRel = paths.get(event.uid)!;
      return { ...event, fachDir: terminRel.split("/")[0], terminRel,
        noteFile: files.get(terminRel), subjectDir: subjects.get(keyOf(event)), subjectFile: subjectFiles.get(keyOf(event)) };
    }),
    raw: `${JSON.stringify(next, null, 2)}\n`,
  };
}
