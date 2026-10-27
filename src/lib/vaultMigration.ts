import { isScalar, parseDocument } from "yaml";
import { appointmentFileName, subjectFileName } from "./filenames.ts";
import { assignEventPaths, readIndex, validateRelativePath } from "./identity.ts";
import { buildFaecher, subjectIdentity, subjectName } from "./ical.ts";
import {
  buildFachMoc, buildSemesterMoc, fachQueryFilter, fachTerminRows, isSafeRelativePath,
  MOC_END, MOC_START, parseNote, refreshGeneratedFachQuery, replaceBetweenMarkers, semesterFachRows,
  toLocalDateKey, toLocalTimeKey,
} from "./notes.ts";
import type { PathIndex } from "./identity.ts";
import type { StudyEvent } from "./types.ts";

export type VaultChange =
  | { kind: "write"; path: string; before: string | null; content: string }
  | { kind: "rename"; from: string; path: string; before: string; content: string }
  | { kind: "archive"; path: string; before: string; canonical: string };

export interface VaultMigrationPlan {
  version: 1;
  semester: string;
  changes: VaultChange[];
  files: Map<string, string>;
  events: StudyEvent[];
  index: PathIndex;
  rawIndex: string;
  summary: {
    events: number; subjects: number; writes: number; renames: number; archives: number;
    preservedOriginals: number; rewrittenLinks: number; upgradedQueries: number; normalizedLvFields: number;
    existingUidPaths: number; preservedUidPaths: number; existingNotes: number;
    unchangedNoteBytes: number; unchangedNoteBodies: number;
  };
}

interface Subject {
  key: string;
  name: string;
  identity: string;
  types: string[];
  lvs: string[];
  events: StudyEvent[];
}

const pathKey = (value: string) => value.normalize("NFC").toLowerCase();
const baseName = (value: string) => value.slice(value.lastIndexOf("/") + 1);
const parentDir = (value: string) => value.slice(0, Math.max(0, value.lastIndexOf("/")));
const stem = (value: string) => value.replace(/\.md$/i, "");
const hiddenPath = (value: string) => value.split("/").some((part) => part.startsWith("."));
const lvNumber = (value: string) => value.trim().split(/\s|\\n/i)[0];
const nameKey = (value: string) => subjectName(value).toLowerCase();

function fail(message: string): never {
  throw new Error(`Vault-Migration: ${message}`);
}

function validateFiles(files: ReadonlyMap<string, string>, semester: string): void {
  validateRelativePath(semester, 1);
  const seen = new Set<string>();
  for (const [path, content] of files) {
    if (!isSafeRelativePath(path) || typeof content !== "string") fail("Ungültiger Eingabepfad oder Dateiinhalt.");
    const key = pathKey(path);
    if (seen.has(key)) fail("Dateikollision durch Großschreibung oder Unicode-Normalisierung.");
    seen.add(key);
  }
}

function collectSubjects(events: StudyEvent[]): Map<string, Subject> {
  const subjects = new Map<string, Subject>();
  for (const event of events) {
    if ([event.uid, event.fach, event.typ, event.fachKey, event.lvNummer, event.dozent, event.start, event.end]
      .some((value) => typeof value !== "string") || !Number.isFinite(Date.parse(event.start))
      || !Number.isFinite(Date.parse(event.end))) fail("Ungültiger Kalendertermin.");
    const lv = lvNumber(event.lvNummer);
    const identity = subjectIdentity(lv, event.fach);
    const current = subjects.get(event.fachKey);
    if (current && current.identity !== identity) fail("Widersprüchliche Fachidentität im Kalender.");
    if (current) current.events.push(event);
    else subjects.set(event.fachKey, { key: event.fachKey, name: subjectName(event.fach), identity, types: [], lvs: [], events: [event] });
  }
  const identities = new Set<string>();
  for (const subject of subjects.values()) {
    subject.name = subject.events.map((event) => subjectName(event.fach)).sort()[0];
    subject.types = [...new Set(subject.events.map((event) => event.typ))].sort();
    subject.lvs = [...new Set(subject.events.map((event) => lvNumber(event.lvNummer)).filter(Boolean))].sort();
    if (identities.has(subject.identity)) fail("Kalender muss vor der Migration nach Fach gruppiert sein.");
    identities.add(subject.identity);
  }
  return subjects;
}

function metadataLvNumbers(data: Record<string, unknown>, body = ""): string[] {
  const bodyLv = body.match(/\bLV(?:-Nummer)?[ :\t]+([^\s\\]+)/i)?.[1];
  const lv = typeof data.lv === "string" && data.lv.trim() ? lvNumber(data.lv) : bodyLv;
  const lvs = Array.isArray(data.lv) ? data.lv.filter((value): value is string => typeof value === "string" && !!value.trim()).map(lvNumber) : [];
  if (lv) lvs.push(lv);
  return lvs;
}

function includeHistoricalMetadata(subject: Subject, data: Record<string, unknown>, lvs: string[]): void {
  subject.lvs = [...new Set([...subject.lvs, ...lvs])].sort();
  const types = typeof data.typ === "string" ? data.typ.split(/\s*[/,]\s*/) : [];
  types.push(...lvs.map((lv) => lv.match(/-(VO|UE|ILV)$/i)?.[1].toUpperCase() ?? ""));
  subject.types = [...new Set([...subject.types, ...types.filter((typ) => /^(VO|UE|ILV|SONST)$/.test(typ))])].sort();
}

function matchSubject(content: string, subjects: Map<string, Subject>): Subject {
  const { data, body } = parseNote(content);
  const heading = body.match(/^#\s+(.+?)(?:\r?\n|$)/m)?.[1] ?? "";
  const name = (typeof data.fach === "string" ? data.fach : heading).replace(/\s*\((VO|UE|ILV|SONST)\)\s*$/, "");
  const lvs = metadataLvNumbers(data, body);
  const candidates = [...subjects.values()].filter((subject) =>
    lvs.length ? lvs.every((value) => subject.identity === subjectIdentity(value, name))
      : subject.events.some((event) => nameKey(event.fach) === nameKey(name)));
  if (candidates.length !== 1) fail("Altes Fach-MOC ist unbekannt oder mehrdeutig; Original bleibt unverändert.");
  return candidates[0];
}

function generatedBlock(content: string, rows: string): string {
  const starts = content.split(MOC_START).length - 1;
  const ends = content.split(MOC_END).length - 1;
  if (starts !== 1 || ends !== 1 || content.indexOf(MOC_END) < content.indexOf(MOC_START)) {
    fail("Generierter MOC-Bereich fehlt oder ist mehrdeutig.");
  }
  return replaceBetweenMarkers(content, rows).text;
}

function hasCustomMaterial(content: string, semester: string): boolean {
  const { data, body } = parseNote(content);
  const front = content.slice(0, content.length - body.length);
  if (Object.keys(data).some((key) => !["tags", "fach", "typ", "lv"].includes(key)) || /(^|\s)#/.test(front)) return true;
  const tags = Array.isArray(data.tags) ? data.tags : [data.tags];
  if (tags.some((tag) => typeof tag !== "string" || !/^(?:mci\/|fach\/)/.test(tag))) return true;
  let remainder = body.replace(/^# [^\r\n]+\r?\n\s*\r?\n(?:([^\r\n]+)\r?\n\s*\r?\n)?> [^\r\n]+(?:\r?\n|$)/,
    (header, breadcrumb: string | undefined) => breadcrumb === undefined || breadcrumb === `[[${semester}/_Semester|Semester-Übersicht]]` ? "" : header);
  const start = remainder.indexOf(MOC_START);
  const end = remainder.indexOf(MOC_END);
  if (start === -1 || end < start) return true;
  const rows = remainder.slice(start + MOC_START.length, end).trim();
  if (rows.split(/\r?\n/).some((line) => !/^(- \[\[.+\]\]|_Noch keine Termine\._|)$/.test(line))) return true;
  remainder = remainder.slice(0, start) + remainder.slice(end + MOC_END.length);
  remainder = remainder.replace(/```dataview\r?\nTABLE termin AS Termin, vorbereitet AS VB, nachbereitet AS NB\r?\nFROM "[^"\r\n]+"\r?\nWHERE (?:file\.name = "notes"|uid(?: AND (?:lv = "[^"\r\n]+"|fach = "[^"\r\n]+" AND typ = "[^"\r\n]+"))?)\r?\nSORT termin ASC\r?\n```/g, "");
  if (typeof data.fach === "string") {
    const values = Array.isArray(data.lv) ? data.lv : [data.lv];
    const filter = fachQueryFilter(data.fach, values.filter((value): value is string => typeof value === "string"));
    remainder = remainder.replace(/```dataview\r?\nTABLE termin AS Termin, vorbereitet AS VB, nachbereitet AS NB\r?\nFROM "[^"\r\n]+"\r?\nWHERE uid AND ([^\r\n]+)\r?\nSORT termin ASC\r?\n```/g,
      (query, condition: string) => condition === filter ? "" : query);
  }
  remainder = remainder.replace(/^## (?:Termine|Offene Fragen|Prüfungsthemen)\s*$/gm, "");
  return remainder.trim() !== "";
}

function preservedOriginal(path: string, content: string): string {
  const fence = "`".repeat(Math.max(3, ...[...content.matchAll(/`+/g)].map((match) => match[0].length)) + 1);
  return `\n\n### Original: ${path}\n\n${fence}text\n${content}${content.endsWith("\n") ? "" : "\n"}${fence}\n`;
}

function transformFences(content: string, prose: (part: string) => string, dataview?: (part: string) => string): string {
  const lines = content.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  let fence: string | undefined;
  let language = "";
  let block = "";
  let result = "";
  for (const line of lines) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})([^\r\n]*)/);
    if (!fence && marker) {
      result += prose(block) + line;
      block = "";
      fence = marker[1];
      language = marker[2].trim();
    } else if (fence && marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) {
      result += (language === "dataview" && dataview ? dataview(block) : block) + line;
      block = "";
      fence = undefined;
    } else block += line;
  }
  return result + (fence ? block : prose(block));
}

function outsideInlineCode(content: string, transform: (part: string) => string): string {
  return content.split(/(`+[^`]*(?:`[^`]+)*?`+|(?<!\\)\\`)/g).map((part) =>
    part.startsWith("`") || part === "\\`" ? part : transform(part)).join("");
}

function resolvePath(value: string): string | null {
  const parts: string[] = [];
  for (const part of value.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(part);
  }
  return parts.join("/");
}

function relativePath(from: string, to: string): string {
  const left = from.split("/").filter(Boolean);
  const right = to.split("/");
  while (left.length && left[0] === right[0]) { left.shift(); right.shift(); }
  return [...left.map(() => ".."), ...right].join("/");
}

function encodeLink(value: string): string {
  return value.split("/").map((part) => encodeURIComponent(part).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)).join("/");
}

function rewriteLinks(
  content: string, source: string, semester: string, targets: Map<string, string>, universe: Set<string>,
  changed: () => void,
): string {
  const paths = new Map([...universe].map((path) => [pathKey(stem(path)), path]));
  const rewrite = (target: string, wiki: boolean): string => {
    const split = target.search(/[#|]/);
    const raw = split === -1 ? target : target.slice(0, split);
    const suffix = split === -1 ? "" : target.slice(split);
    if (!raw || /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(raw)) return target;
    let decoded: string;
    try { decoded = decodeURIComponent(raw.replace(/\\([ ()])/g, "$1")); }
    catch { fail("Ungültige URL-Kodierung in einem lokalen Link."); }
    const wanted = pathKey(stem(decoded));
    let candidates: string[];
    if (decoded.startsWith(".")) {
      const relative = resolvePath(`${parentDir(source)}/${decoded}`);
      candidates = relative ? [paths.get(pathKey(stem(relative)))].filter((path): path is string => path !== undefined) : [];
    } else if (decoded.startsWith("/")) {
      candidates = [paths.get(wanted.slice(1))].filter((path): path is string => path !== undefined);
    } else if (!wiki && paths.has(pathKey(stem(resolvePath(`${parentDir(source)}/${decoded}`) ?? "")))) {
      candidates = [paths.get(pathKey(stem(resolvePath(`${parentDir(source)}/${decoded}`)!)))!];
    } else if (!decoded.includes("/")) {
      candidates = [...universe].filter((path) => pathKey(stem(baseName(path))) === wanted);
    } else {
      candidates = [...new Set([decoded, `${parentDir(source)}/${decoded}`, `${semester}/${decoded}`]
        .map((path) => paths.get(pathKey(stem(resolvePath(path) ?? ""))))
        .filter((path): path is string => path !== undefined))];
      if (!candidates.length) candidates = [...universe].filter((path) => pathKey(stem(path)).endsWith(`/${wanted}`));
    }
    const affected = candidates.filter((path) => targets.has(path));
    if (!affected.length) return target;
    if (candidates.length !== 1) fail("Mehrdeutiger lokaler Link auf eine umzubenennende Datei.");
    const destination = targets.get(affected[0])!;
    const withExtension = /\.md$/i.test(raw);
    const next = wiki ? (withExtension ? destination : stem(destination))
      : encodeLink(relativePath(parentDir(source), withExtension ? destination : stem(destination)));
    const result = `${next}${suffix}`;
    if (result !== target) changed();
    return result;
  };
  return transformFences(content, (prose) => outsideInlineCode(prose, (text) => {
    const wiki = text.replace(/(?<!\\)(!?\[\[)([^\]\n]+)(\]\])/g, (_match, open: string, target: string, close: string) =>
      `${open}${rewrite(target, true)}${close}`);
    // Parse destinations separately from labels and titles; balanced parentheses are valid in filenames.
    const starts = [...wiki.matchAll(/(?<!\\)\]\(|^ {0,3}\[[^\]\n]+\]:[ \t]*/gm)];
    let result = "";
    let cursor = 0;
    for (const match of starts) {
      const start = match.index + match[0].length;
      if (start < cursor) continue;
      let end = start;
      const angle = wiki[start] === "<";
      if (angle) {
        end = wiki.indexOf(">", start + 1);
        if (end === -1) continue;
      } else {
        let depth = 0;
        for (; end < wiki.length; end++) {
          const char = wiki[end];
          if (char === "\\") { end++; continue; }
          if (char === "(") depth++;
          if (char === ")") { if (depth === 0) break; depth--; }
          if (/\s/.test(char) && depth === 0) break;
        }
      }
      const targetStart = start + Number(angle);
      result += wiki.slice(cursor, targetStart) + rewrite(wiki.slice(targetStart, end), false);
      cursor = end;
    }
    return result + wiki.slice(cursor);
  }));
}

function upgradeQueries(content: string, semester: string, directories: Map<string, Subject | null>, changed: () => void): string {
  return transformFences(content, (part) => part, (query) => {
    if (!/file\.name\s*=\s*(["'])notes\1/.test(query)) return query;
    const from = query.match(/^FROM\s+"([^"\r\n]+)"\s*$/m);
    if (!from) return query;
    const subject = directories.get(from[1]);
    if (subject === null) fail("Dataview-Ordner enthält mehrere LV; Fachfilter ist mehrdeutig.");
    if (from[1] !== semester && !subject) return query;
    const filter = subject ? ` AND ${fachQueryFilter(subject.name, subject.lvs)}` : "";
    const next = query.replace(from[0], from[0].replace(`"${from[1]}"`, `"${semester}"`))
      .replace(/file\.name\s*=\s*(["'])notes\1/g, `uid${filter}`);
    if (next !== query) changed();
    return next;
  });
}

function normalizeLvField(content: string, expected: string | undefined, changed: () => void): string {
  const { data, body } = parseNote(content);
  if (typeof data.lv !== "string" || !data.lv || lvNumber(data.lv) === data.lv) return content;
  const value = lvNumber(data.lv);
  if (!expected || value !== expected) fail("Historisches LV-Feld lässt sich nicht eindeutig zuordnen.");
  const start = content.match(/^\uFEFF?---[ \t]*\r?\n/)![0].length;
  const end = content.length - body.length;
  const yaml = content.slice(start, end).replace(/(?:---|\.\.\.)[ \t]*\r?\n?$/, "");
  const node = parseDocument(yaml).get("lv", true);
  if (!isScalar(node) || !node.range) fail("LV-Feld kann nicht gezielt ersetzt werden.");
  changed();
  return content.slice(0, start + node.range[0]) + JSON.stringify(value) + content.slice(start + node.range[1]);
}

export function planVaultMigration(input: {
  files: ReadonlyMap<string, string>;
  events: StudyEvent[];
  semester: string;
}): VaultMigrationPlan {
  const { files, semester } = input;
  validateFiles(files, semester);
  const indexPath = `${semester}/.mci-manager/event-paths.json`;
  const oldRaw = files.get(indexPath) ?? null;
  const oldIndex = readIndex(oldRaw);
  const subjects = collectSubjects(input.events);
  if (!subjects.size) fail("Ein leerer Kalender ist keine sichere Migrationsgrundlage.");
  const existingMocs = new Map<string, Subject>();
  const indexedMocs = new Map<string, string>();
  for (const [key, file] of Object.entries(oldIndex.subjectFiles)) {
    const dir = oldIndex.subjects[key];
    if (!dir) fail("Der Fachdatei fehlt ein zugeordneter Ordner.");
    const path = `${semester}/${dir}/${file}`;
    if ([...indexedMocs.keys()].some((other) => pathKey(other) === pathKey(path))) fail("Mehrere Fächer beanspruchen dieselbe Fachdatei.");
    indexedMocs.set(path, key);
  }
  const notes: Array<{ terminRel: string; content: string; fileName: string }> = [];
  for (const [path, content] of files) {
    if (!path.startsWith(`${semester}/`) || hiddenPath(path)) continue;
    const parts = path.slice(semester.length + 1).split("/");
    if (parts.length === 2 && (parts[1] === "_Fach.md" || indexedMocs.has(path))) existingMocs.set(path, matchSubject(content, subjects));
    if (parts.length !== 3 || !path.endsWith(".md") || parts.some((part) => part.startsWith("."))) continue;
    const terminRel = parts.slice(0, 2).join("/");
    let managed = parts[2] === "notes.md" || oldIndex.files[terminRel] === parts[2];
    if (!managed) {
      try {
        const uid = parseNote(content).data.uid;
        managed = typeof uid === "string" && !!uid.trim();
      } catch { /* Unmanaged Markdown is preserved without interpreting its YAML. */ }
    }
    if (managed) {
      notes.push({ terminRel, content, fileName: parts[2] });
    }
  }
  for (const [path, subject] of existingMocs) {
    const { data, body } = parseNote(files.get(path)!);
    includeHistoricalMetadata(subject, data, metadataLvNumbers(data, body));
  }
  for (const note of notes) {
    const { data } = parseNote(note.content);
    const lvs = metadataLvNumbers(data);
    if (!lvs.length) continue;
    const subject = [...subjects.values()].find((candidate) => lvs.every((lv) => subjectIdentity(lv, candidate.name) === candidate.identity));
    if (subject) includeHistoricalMetadata(subject, data, lvs);
  }
  // Subject directories may merge; UID directories must never move.
  const seed = readIndex(oldRaw);
  for (const [path, subject] of existingMocs) {
    const oldKey = indexedMocs.get(path);
    if (oldKey && oldKey !== subject.key) delete seed.subjectFiles[oldKey];
  }
  for (const subject of subjects.values()) {
    const sources = [...existingMocs].filter(([, match]) => match.key === subject.key).map(([path]) => path).sort();
    if (!seed.subjects[subject.key]) {
      const adopted = notes.filter((note) => subject.events.some((event) => parseNote(note.content).data.uid === event.uid))
        .map((note) => note.terminRel.split("/")[0]).sort()[0];
      const historical = sources[0]?.split("/")[1];
      if (adopted || historical) seed.subjects[subject.key] = adopted || historical;
    }
    const previous = sources.find((path) => indexedMocs.has(path) && path.split("/")[1] === seed.subjects[subject.key]);
    if (!seed.subjectFiles[subject.key] && sources.length === 1 && previous
      && subjectName(stem(baseName(previous))) === stem(baseName(previous))) {
      seed.subjectFiles[subject.key] = baseName(previous);
    }
  }
  const normalizedEvents = input.events.map((event) => ({ ...event, fach: subjects.get(event.fachKey)!.name, lvNummer: lvNumber(event.lvNummer) }));
  const assigned = assignEventPaths(JSON.stringify(seed), notes, normalizedEvents, "subject");
  const index = readIndex(assigned.raw);
  const final = new Map(files);
  const renames = new Map<string, string>();
  const archives = new Map<string, string>();
  const targets = new Map<string, string>();
  const universe = new Set([...files.keys()].filter((path) => path.endsWith(".md") && !hiddenPath(path)));
  const summary = { events: input.events.length, subjects: subjects.size, writes: 0, renames: 0, archives: 0,
    preservedOriginals: 0, rewrittenLinks: 0, upgradedQueries: 0, normalizedLvFields: 0,
    existingUidPaths: Object.keys(oldIndex.paths).length, preservedUidPaths: 0,
    existingNotes: notes.length, unchangedNoteBytes: 0, unchangedNoteBodies: 0 };
  const occupied = new Map([...files.keys()].map((path) => [pathKey(path), path]));
  const claim = (path: string, source?: string) => {
    const existing = occupied.get(pathKey(path));
    if (existing !== undefined && existing !== source) fail("Zieldatei existiert bereits; keine Datei wird überschrieben.");
    occupied.set(pathKey(path), path);
  };
  for (const event of assigned.events) {
    const oldFile = index.files[event.terminRel];
    if (oldFile === "notes.md") index.files[event.terminRel] = appointmentFileName(event.fach, toLocalDateKey(event.start), toLocalTimeKey(event.start));
    const oldPath = `${semester}/${event.terminRel}/notes.md`;
    const nextPath = `${semester}/${event.terminRel}/${index.files[event.terminRel]}`;
    const occupiedNote = occupied.get(pathKey(nextPath));
    if (occupiedNote !== undefined && !notes.some((note) => `${semester}/${note.terminRel}/${note.fileName}` === occupiedNote)) {
      fail("Geplanter Terminname kollidiert mit einer fremden Datei.");
    }
    if (oldPath !== nextPath) { targets.set(oldPath, nextPath); universe.add(oldPath); }
  }
  for (const note of notes) {
    const { data } = parseNote(note.content);
    if (typeof data.uid !== "string" || !data.uid.trim()) fail("Terminnotiz ohne UID kann nicht sicher migriert werden.");
    const event = assigned.events.find((candidate) => candidate.uid === data.uid);
    const oldPath = `${semester}/${note.terminRel}/${note.fileName}`;
    let file = index.files[note.terminRel];
    if (file === "notes.md") {
      if (typeof data.fach !== "string" || typeof data.termin !== "string" || !Number.isFinite(Date.parse(data.termin))) {
        fail("Historischer Termin ohne Kalenderzuordnung benötigt Fach und gültiges Datum.");
      }
      file = appointmentFileName(subjectName(data.fach), toLocalDateKey(data.termin), toLocalTimeKey(data.termin));
      index.files[note.terminRel] = file;
    }
    const path = `${semester}/${note.terminRel}/${file}`;
    const content = normalizeLvField(note.content, event?.lvNummer, () => summary.normalizedLvFields++);
    if (path !== oldPath) {
      claim(path);
      final.delete(oldPath);
      renames.set(oldPath, path);
      targets.set(oldPath, path);
    }
    final.set(path, content);
  }
  const subjectPaths = new Map<string, string>();
  for (const subject of subjects.values()) {
    const dir = index.subjects[subject.key];
    if (index.subjectFiles[subject.key] === "_Fach.md") index.subjectFiles[subject.key] = subjectFileName(subject.name);
    const path = `${semester}/${dir}/${index.subjectFiles[subject.key]}`;
    const existing = files.get(path);
    if ([...subjectPaths.values()].some((other) => pathKey(other) === pathKey(path))) fail("Mehrere Fächer beanspruchen dieselbe Zieldatei.");
    subjectPaths.set(subject.key, path);
    if (existing !== undefined) {
      if (!indexedMocs.has(path) || existingMocs.get(path)?.key !== subject.key) fail("Fach-Zieldatei ist keine bekannte kanonische Fachnotiz.");
    }
    claim(path, existing !== undefined ? path : undefined);
  }
  const events = assigned.events.map((event) => ({ ...event, noteFile: index.files[event.terminRel],
    subjectDir: index.subjects[event.fachKey], subjectFile: index.subjectFiles[event.fachKey] }));
  const semesterTag = `mci/${semester.toLowerCase().replace(/_/g, "-").split("-").find((part) => /^sem\d+$/.test(part))
    ?? semester.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")}`;
  const directories = new Map<string, Subject | null>();
  const registerDirectory = (dir: string, subject: Subject) => {
    const previous = directories.get(dir);
    directories.set(dir, previous === undefined || previous?.key === subject.key ? subject : null);
  };
  for (const event of events) registerDirectory(`${semester}/${event.fachDir}`, subjects.get(event.fachKey)!);
  for (const [path, subject] of existingMocs) {
    const canonical = subjectPaths.get(subject.key)!;
    if (path === canonical) continue;
    targets.set(path, canonical);
    archives.set(path, canonical);
    registerDirectory(parentDir(path), subject);
    final.delete(path);
  }
  for (const subject of subjects.values()) {
    const path = subjectPaths.get(subject.key)!;
    const group = events.filter((event) => event.fachKey === subject.key);
    const existing = files.get(path);
    const merged = [...existingMocs].some(([source, match]) => match.key === subject.key && source !== path);
    let content = existing === undefined || merged ? buildFachMoc({ fach: subject.name, typ: subject.types.join(" / "),
      dozent: [...new Set(group.map((event) => event.dozent).filter(Boolean))].sort().join(", "),
      lvBeispiel: subject.lvs[0] ?? "", lvNummern: subject.lvs, fachDir: index.subjects[subject.key], semesterPath: semester,
      fachTag: `fach/${subject.key}`, semesterTag, termine: group })
      : transformFences(existing, (part) => part.includes(MOC_START) ? generatedBlock(part, fachTerminRows(group, semester)) : part);
    content = refreshGeneratedFachQuery(content, { fach: subject.name, lvNummern: subject.lvs, semesterPath: semester });
    for (const [oldPath, match] of existingMocs) {
      if (match.key !== subject.key || (oldPath === path && !merged) || !hasCustomMaterial(files.get(oldPath)!, semester)) continue;
      content += preservedOriginal(oldPath, files.get(oldPath)!);
      summary.preservedOriginals++;
    }
    registerDirectory(parentDir(path), subject);
    final.set(path, content);
  }
  const semesterPath = `${semester}/_Semester.md`;
  const faecher = buildFaecher(events);
  const semesterContent = files.get(semesterPath);
  if (semesterContent === undefined) {
    claim(semesterPath);
    final.set(semesterPath, buildSemesterMoc({ semesterPath: semester, semesterTag, faecher }));
  } else if (semesterContent.includes(MOC_START) || semesterContent.includes(MOC_END)) {
    final.set(semesterPath, generatedBlock(semesterContent, semesterFachRows(semester, faecher)));
  }
  for (const [path, content] of final) {
    if (!path.endsWith(".md") || hiddenPath(path)) continue;
    const originalPath = [...renames].find(([, destination]) => destination === path)?.[0] ?? path;
    const linked = rewriteLinks(content, originalPath, semester, targets, universe, () => summary.rewrittenLinks++);
    final.set(path, upgradeQueries(linked, semester, directories, () => summary.upgradedQueries++));
  }
  const sortedRecord = (record: Record<string, string>) => Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));
  index.files = sortedRecord(index.files);
  index.subjectFiles = sortedRecord(index.subjectFiles);
  const rawIndex = `${JSON.stringify(index, null, 2)}\n`;
  if (!files.has(indexPath)) claim(indexPath);
  final.set(indexPath, rawIndex);
  const changes: VaultChange[] = [];
  for (const [from, path] of renames) changes.push({ kind: "rename", from, path, before: files.get(from)!, content: final.get(path)! });
  for (const [path, canonical] of archives) changes.push({ kind: "archive", path, before: files.get(path)!, canonical });
  const renamed = new Set(renames.values());
  for (const [path, content] of final) {
    if (!renamed.has(path) && content !== files.get(path)) changes.push({ kind: "write", path, before: files.get(path) ?? null, content });
  }
  changes.sort((a, b) => a.path.localeCompare(b.path) || a.kind.localeCompare(b.kind));
  summary.writes = changes.filter((change) => change.kind === "write").length;
  summary.renames = renames.size;
  summary.archives = archives.size;
  summary.preservedUidPaths = Object.entries(oldIndex.paths).filter(([uid, path]) => index.paths[uid] === path).length;
  if (summary.preservedUidPaths !== summary.existingUidPaths) fail("Bestehende UID-Pfade würden verändert.");
  for (const note of notes) {
    const next = final.get(`${semester}/${note.terminRel}/${index.files[note.terminRel]}`)!;
    if (next === note.content) summary.unchangedNoteBytes++;
    if (parseNote(next).body === parseNote(note.content).body) summary.unchangedNoteBodies++;
  }
  return { version: 1, semester, changes, files: final, events, index, rawIndex, summary };
}
