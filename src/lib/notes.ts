import { isMap, parseDocument, stringify } from "yaml";
import { subjectFileName } from "./filenames.ts";
import { subjectIdentity } from "./ical.ts";

const TIME_ZONE = "Europe/Vienna";

// ── Lokale Datums-Helfer ─────────────────────────────────────────────
// start liegt als UTC-ISO vor. slice(0,10) wäre der UTC-Tag — Anzeige
// (eventsAmTag) und Ordnernamen müssen aber den lokalen Tag (Wien)
// nutzen, sonst liegt ein Abend-Termin im falschen Ordner.

export function toLocalDateKey(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(d);
  const part = (type: string) => parts.find((p) => p.type === type)!.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

/** Lokale Uhrzeit als HHMM, für Kollisions-Suffixe am gleichen Tag. */
export function toLocalTimeKey(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "0000";
  return toLocalTime(iso).replace(":", "");
}

export function toLocalDisplay(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("de-AT", { timeZone: TIME_ZONE, weekday: "short", day: "2-digit", month: "2-digit" });
}

export function toLocalTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString("de-AT", { timeZone: TIME_ZONE, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
}

/** Nur relative Pfade innerhalb des Terminordners dürfen geöffnet werden. */
export function isSafeRelativePath(rel: string): boolean {
  if (!rel || /[\\:]/.test(rel) || [...rel].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) return false;
  return !rel.split("/").some((part) => part === ".." || part === "." || part === "");
}

function wikiNoteTarget(path: string): string {
  if (!isSafeRelativePath(path) || !path.endsWith(".md")
    || path.split("/").some((part) => part.startsWith(".") || part !== part.trim() || part.endsWith("."))
    || /[[\]#|^%?*"<>\p{Cf}]/u.test(path)) throw new Error("Ungültiger Wikilink-Pfad.");
  return path.slice(0, -3);
}

// ── Frontmatter ──────────────────────────────────────────────────────
// Die einzige Wahrheit für Termin-Status. Fremde Felder (z.B. von
// Obsidian-Plugins) werden beim Schreiben immer erhalten.

export interface TerminFront {
  fach: string;
  typ: string;
  dozent: string;
  lv: string;
  termin: string;
  uid: string;
  tags: string[];
  vorbereitet: boolean;
  nachbereitet: boolean;
}

// Enumerable symbols survive the object spreads used by status updates, but
// never become YAML keys. Keep the source to retain comments and node styles.
const FRONT_SOURCE = Symbol("frontmatterSource");
type NoteData = Record<string, unknown> & { [FRONT_SOURCE]?: { yaml: string; prefix: string } };

function frontDocument(source: string) {
  const doc = parseDocument(source, { stringKeys: true, resolveKnownTags: false, intAsBigInt: true });
  if (doc.errors.length || doc.warnings.length) {
    throw new Error("Das YAML-Frontmatter ist fehlerhaft oder enthält nicht unterstützte Tags.");
  }
  if (doc.contents !== null && !isMap(doc.contents)) {
    throw new Error("Das YAML-Frontmatter muss eine Feldzuordnung sein.");
  }
  return doc;
}

function frontData(doc: ReturnType<typeof frontDocument>): NoteData {
  return doc.toJS({
    maxAliasCount: 100,
    reviver: (_key, value: unknown) => typeof value === "bigint"
      && value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(value) : value,
  }) ?? {};
}

export function parseNote(raw: string): { data: Record<string, unknown>; body: string } {
  const opening = raw.match(/^\uFEFF?---[ \t]*\r?\n/);
  if (!opening) {
    if (/^\uFEFF?---[ \t]*$/.test(raw)) throw new Error("Das YAML-Frontmatter ist nicht abgeschlossen.");
    return { data: {}, body: raw };
  }
  const rest = raw.slice(opening[0].length);
  const closing = /^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/m.exec(rest);
  if (!closing) throw new Error("Das YAML-Frontmatter ist nicht abgeschlossen.");
  const yaml = rest.slice(0, closing.index);
  const doc = frontDocument(yaml);
  const data = frontData(doc);
  const end = opening[0].length + closing.index + closing[0].length;
  data[FRONT_SOURCE] = { yaml, prefix: raw.slice(0, end) };
  return { data, body: raw.slice(end) };
}

export function serializeNote(data: Record<string, unknown>, body: string): string {
  const source = (data as NoteData)[FRONT_SOURCE];
  if (source) {
    const doc = frontDocument(source.yaml);
    const previous = frontData(doc);
    let changed = false;
    for (const key of Object.keys(previous)) {
      if (!Object.prototype.hasOwnProperty.call(data, key)) {
        doc.delete(key);
        changed = true;
      }
    }
    for (const key of Object.keys(data)) {
      if (!doc.has(key) || stringify(previous[key]) !== stringify(data[key])) {
        doc.set(key, data[key]);
        changed = true;
      }
    }
    if (!changed) return `${source.prefix}${body}`;
    const yaml = doc.toString({ lineWidth: 0 });
    const roundTrip = frontData(frontDocument(yaml));
    if (Object.keys(data).some((key) => stringify(roundTrip[key]) !== stringify(data[key]))) {
      throw new Error("Die YAML-Verknüpfungen erlauben diese Änderung nicht ohne Datenverlust.");
    }
    return `---\n${yaml}---\n${body}`;
  }
  const known = ["fach", "typ", "dozent", "lv", "termin", "uid", "tags", "vorbereitet", "nachbereitet"];
  const keys = [...known.filter((key) => Object.prototype.hasOwnProperty.call(data, key)), ...Object.keys(data).filter((key) => !known.includes(key))];
  const ordered = Object.fromEntries(keys.map((key) => [key, data[key]]));
  return `---\n${stringify(ordered, { lineWidth: 0 })}---\n${body}`;
}

function asBool(v: unknown): boolean {
  return v === true;
}

// ── Status-Regel ─────────────────────────────────────────────────────
// vorbereitet ⟺ alle Tasks unter "## Vorbereitung" sind abgehakt.
// Enthält die Sektion keine Tasks (fremde Note), gilt das Frontmatter-Flag.
// Gleiches für "## Nachbereitung". So sind App-Checkbox und Markdown-Task
// derselbe Zustand — egal, wo man abhakt.

const TASK_RE = /^(\s*[-*]\s+)\[([ xX])\](.*?)(\r?)$/;
const FENCE_RE = /^\s*```/;

function findSection(lines: string[], heading: string): { from: number; to: number } | null {
  const want = heading.trim().toLowerCase();
  let start = -1;
  let level = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(#{1,3})\s+(.+?)\s*$/);
    if (!m) continue;
    if (start === -1) {
      if (m[2].trim().toLowerCase() === want) {
        start = i + 1;
        level = m[1].length;
      }
    } else if (m[1].length <= level) {
      return { from: start, to: i };
    }
  }
  return start === -1 ? null : { from: start, to: lines.length };
}

/** Alle Task-Zustände einer Sektion (Code-Blöcke werden ignoriert). */
export function sectionTasks(body: string, heading: string): boolean[] {
  const lines = body.split("\n");
  const sec = findSection(lines, heading);
  if (!sec) return [];
  const out: boolean[] = [];
  let fence = false;
  for (let i = sec.from; i < sec.to; i++) {
    const line = lines[i];
    if (FENCE_RE.test(line)) {
      fence = !fence;
      continue;
    }
    if (fence) continue;
    const m = line.match(TASK_RE);
    if (m) out.push(m[2].toLowerCase() === "x");
  }
  return out;
}

/** true/false wenn Tasks vorhanden, sonst null (Fallback: Frontmatter). */
export function sectionAllChecked(body: string, heading: string): boolean | null {
  const tasks = sectionTasks(body, heading);
  if (tasks.length === 0) return null;
  return tasks.every(Boolean);
}

export function readStatus(
  data: Record<string, unknown>,
  body: string,
): { vorbereitet: boolean; nachbereitet: boolean } {
  return {
    vorbereitet: sectionAllChecked(body, "Vorbereitung") ?? asBool(data["vorbereitet"]),
    nachbereitet: sectionAllChecked(body, "Nachbereitung") ?? asBool(data["nachbereitet"]),
  };
}

/** Setzt Flag + alle Tasks der Sektion auf denselben Wert. */
export function writeStatus(
  data: Record<string, unknown>,
  body: string,
  key: "vorbereitet" | "nachbereitet",
  value: boolean,
): { data: Record<string, unknown>; body: string } {
  const heading = key === "vorbereitet" ? "Vorbereitung" : "Nachbereitung";
  const lines = body.split("\n");
  const sec = findSection(lines, heading);
  if (sec) {
    let fence = false;
    for (let i = sec.from; i < sec.to; i++) {
      const line = lines[i];
      if (FENCE_RE.test(line)) {
        fence = !fence;
        continue;
      }
      if (fence) continue;
      const m = line.match(TASK_RE);
      if (m) lines[i] = `${m[1]}[${value ? "x" : " "}]${m[3]}${m[4]}`;
    }
  }
  return { data: { ...data, [key]: value }, body: lines.join("\n") };
}

// ── Termin-Note ──────────────────────────────────────────────────────

export interface TerminInput {
  fach: string;
  typ: string;
  summary: string;
  start: string;
  end: string;
  dozent: string;
  uid: string;
  lv: string;
  fachTag: string;
  semesterTag: string;
  fachPath: string;
}

export function buildTerminFront(input: TerminInput): TerminFront {
  return {
    fach: input.fach,
    typ: input.typ,
    dozent: input.dozent,
    lv: input.lv,
    termin: toLocalDateKey(input.start),
    uid: input.uid,
    tags: [input.semesterTag, input.fachTag],
    vorbereitet: false,
    nachbereitet: false,
  };
}

const TERMIN_BODY = (o: {
  summary: string;
  dozent: string;
  when: string;
  fachPath: string;
}): string =>
  `> ${o.summary}\n> ${o.dozent} · ${o.when}\n\n[[${wikiNoteTarget(o.fachPath)}|Fachübersicht]]\n\n## Vorbereitung\n- [ ] Skript/Kapitel gelesen\n- [ ] Lernziele verstanden\n- [ ] Fragen notiert\n\n## Mitschrift\n\n## Nachbereitung\n- [ ] Zusammenfassung in eigenen Worten geschrieben\n- [ ] Offene Punkte geklärt\n\n## Prüfung\n\n## Anhang\n`;

/** Komplette notes.md für einen neuen Termin (Frontmatter + Sektionen). */
export function buildTerminNote(input: TerminInput): string {
  const when = `${toLocalDisplay(input.start)}, ${toLocalTime(input.start)} – ${toLocalTime(input.end)}`;
  return serializeNote(
    buildTerminFront(input) as unknown as Record<string, unknown>,
    TERMIN_BODY({ summary: input.summary, dozent: input.dozent, when, fachPath: input.fachPath }),
  );
}

// ── MOCs & Vault-Gerüst ──────────────────────────────────────────────

export interface MocTermin {
  start: string;
  terminRel: string;
  summary: string;
  noteFile?: string;
}

/** Fach-MOC: statische Linkliste (funktioniert immer) + Dataview (live, wenn installiert). */
export function fachTerminRows(termine: MocTermin[], semesterPath = ""): string {
  return [...termine]
    .sort((a, b) => a.start.localeCompare(b.start))
    .map((t) => {
      const label = `${toLocalDisplay(t.start)}, ${toLocalTime(t.start)}`;
      const file = (t.noteFile ?? "notes.md").slice(0, -3);
      return `- [[${semesterPath ? `${semesterPath}/` : ""}${t.terminRel}/${file}|${label}]]`;
    })
    .join("\n");
}

export const MOC_START = "<!-- sm:list:start -->";
export const MOC_END = "<!-- sm:list:end -->";

function fachNames(fach: string): string[] {
  return [fach, ...["VO", "UE", "ILV"].flatMap((typ) => [`${fach} ${typ}`, `${fach} (${typ})`])];
}

function uniqueLvNummern(lvNummern: string[]): string[] {
  return [...new Set(lvNummern.map((lv) => lv.trim()).filter(Boolean))].sort();
}

export function fachQueryFilter(fach: string, lvNummern: string[]): string {
  const numbers = uniqueLvNummern(lvNummern);
  if (numbers.length === 1) return `lv = ${JSON.stringify(numbers[0])}`;
  if (numbers.length > 1) return `contains(${JSON.stringify(numbers)}, lv)`;
  return `contains(${JSON.stringify(fachNames(fach))}, fach)`;
}

function transformMocBlocks(content: string, transform: (block: string, language: string | null) => string): string {
  let fence: string | undefined;
  let language = "";
  let block = "";
  let result = "";
  for (const line of content.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})([^\r\n]*)/);
    if (!fence && marker) {
      result += transform(block, null);
      block = line;
      fence = marker[1];
      language = marker[2].trim();
    } else if (fence && marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) {
      result += transform(block + line, language);
      block = "";
      fence = undefined;
    } else block += line;
  }
  return result + (fence ? block : transform(block, null));
}

export function refreshGeneratedFachQuery(content: string, options: {
  fach: string;
  lvNummern: string[];
  semesterPath: string;
}): string {
  const numbers = uniqueLvNummern(options.lvNummern);
  const identities = new Set(numbers.map((lv) => subjectIdentity(lv, options.fach)));
  const names = fachNames(options.fach);
  const filter = fachQueryFilter(options.fach, numbers);
  const scope = JSON.stringify(options.semesterPath);
  return transformMocBlocks(content, (block, language) => {
    if (language !== "dataview") return block;
    const match = block.match(/^```dataview(\r?\n)TABLE termin AS Termin, vorbereitet AS VB, nachbereitet AS NB\r?\nFROM ("(?:[^"\\\r\n]|\\.)*")\r?\nWHERE ([^\r\n]+)\r?\nSORT termin ASC\r?\n```(\r?\n)?$/);
    if (!match || (match[2] !== scope && !match[2].startsWith(`${scope.slice(0, -1)}/`))) return block;
    const condition = match[3];
    const current = condition.startsWith("uid AND ") ? condition.slice(8) : "";
    let nextFilter = filter;
    let known = condition === 'file.name = "notes"' || condition === "uid" || current === filter
      || names.some((name) => ["VO", "UE", "ILV", "SONST"].some((typ) =>
        current === `fach = ${JSON.stringify(name)} AND typ = ${JSON.stringify(typ)}`));
    const list = current.match(/^(?:lv = ("(?:[^"\\]|\\.)*")|contains\((\[.*\]), (lv|fach)\))$/);
    if (list) {
      try {
        const values: unknown = list[1] ? [JSON.parse(list[1])] : JSON.parse(list[2]);
        if (!Array.isArray(values) || !values.length || !values.every((value): value is string => typeof value === "string")) return block;
        const isLv = Boolean(list[1]) || list[3] === "lv";
        known = values.every((value) => isLv
          ? identities.has(subjectIdentity(value, options.fach)) : names.includes(value));
        if (known && isLv) nextFilter = fachQueryFilter(options.fach, [...numbers, ...values]);
      } catch { return block; }
    }
    if (!known) return block;
    return block.replace(`FROM ${match[2]}${match[1]}WHERE ${condition}`, () => `FROM ${scope}${match[1]}WHERE uid AND ${nextFilter}`);
  });
}

export function buildFachMoc(o: {
  fach: string;
  typ: string;
  dozent: string;
  lvBeispiel: string;
  lvNummern?: string[];
  fachDir: string;
  semesterPath: string;
  fachTag: string;
  semesterTag: string;
  termine: MocTermin[];
}): string {
  const rows = fachTerminRows(o.termine, o.semesterPath);
  const numbers = uniqueLvNummern(o.lvNummern ?? [o.lvBeispiel]);
  const filter = fachQueryFilter(o.fach, numbers);
  return serializeNote({ tags: [o.semesterTag, o.fachTag], fach: o.fach, typ: o.typ, lv: numbers.length > 1 ? numbers : numbers[0] ?? "" },
    `# ${o.fach}\n\n[[${wikiNoteTarget(`${o.semesterPath}/_Semester.md`)}|Semester-Übersicht]]\n\n> ${o.typ} · ${o.dozent}${numbers.length ? ` · ${numbers.join(", ")}` : ""}\n\n## Termine\n\n${MOC_START}\n${rows || "_Noch keine Termine._"}\n${MOC_END}\n\n\`\`\`dataview\nTABLE termin AS Termin, vorbereitet AS VB, nachbereitet AS NB\nFROM ${JSON.stringify(o.semesterPath)}\nWHERE uid AND ${filter}\nSORT termin ASC\n\`\`\`\n\n## Offene Fragen\n\n## Prüfungsthemen\n`);
}

/** Semester-MOC: Fächer-Links + offene Vor-/Nachbereitung als Dataview. */
export function semesterFachRows(
  semesterPath: string,
  faecher: { name: string; dir: string; termine: number; dozent: string; file?: string }[],
): string {
  return faecher
    .map((f) => `- [[${semesterPath}/${f.dir}/${(f.file ?? subjectFileName(f.name)).slice(0, -3)}|${f.name.replace(/\|/g, " / ")}]] (${f.termine}) — ${f.dozent}`)
    .join("\n");
}

export function buildSemesterMoc(o: {
  semesterPath: string;
  semesterTag: string;
  faecher: { key: string; name: string; dir: string; termine: number; dozent: string }[];
}): string {
  const rows = semesterFachRows(o.semesterPath, o.faecher);
  return `---\ntags: [${o.semesterTag}]\n---\n# Semester-Übersicht\n\n[[README|Studienübersicht]]\n\n## Fächer\n\n${MOC_START}\n${rows || "_Noch keine Fächer._"}\n${MOC_END}\n\n## Offen\n\n\`\`\`dataview\nTABLE WITHOUT ID fach AS Fach, termin AS Termin, vorbereitet AS VB, nachbereitet AS NB\nFROM "${o.semesterPath}"\nWHERE uid AND (vorbereitet = false OR nachbereitet = false)\nSORT termin ASC\nLIMIT 30\n\`\`\`\n`;
}

/** Vault-Dashboard: morgens/abends der Einstieg in Obsidian. */
export function buildVaultReadme(o: { semesterPath: string; semesterTag: string }): string {
  return `# MCI-Studium\n\n## Heute vorbereiten\n\n\`\`\`dataview\nTABLE WITHOUT ID fach AS Fach, termin AS Termin\nFROM "${o.semesterPath}"\nWHERE uid AND vorbereitet = false AND date(termin) >= date(today)\nSORT termin ASC\nLIMIT 10\n\`\`\`\n\n## Nachbereiten\n\n\`\`\`dataview\nTABLE WITHOUT ID fach AS Fach, termin AS Termin\nFROM "${o.semesterPath}"\nWHERE uid AND nachbereitet = false AND date(termin) <= date(today)\nSORT termin DESC\nLIMIT 10\n\`\`\`\n\n## Struktur\n\n- [[${o.semesterPath}/_Semester|Semester-Übersicht]]\n- Termine leben unter Fach-Ordnern, je eine benannte Markdown-Notiz mit \`docs/\`-Anhang.\n- Status-Felder \`vorbereitet\`/\`nachbereitet\` gehören der App + dir — in beiden abhakbar.\n`;
}

export const TERMIN_TEMPLATE_MD = `---\nfach: \ntyp: \ndozent: \nlv: \ntermin: \nuid: \ntags: []\nvorbereitet: false\nnachbereitet: false\n---\n> Zusammenfassung · Dozent · Zeit\n\n## Vorbereitung\n- [ ] Skript/Kapitel gelesen\n- [ ] Lernziele verstanden\n- [ ] Fragen notiert\n\n## Mitschrift\n\n## Nachbereitung\n- [ ] Zusammenfassung in eigenen Worten geschrieben\n- [ ] Offene Punkte geklärt\n\n## Prüfung\n\n## Anhang\n`;

/** Minimal-Config für Obsidian — wird NUR angelegt, nie überschrieben. */
export const OBSIDIAN_APP_JSON = JSON.stringify(
  { livePreview: true, userIgnoreFilters: [".mci-manager"] },
  null,
  2,
);

// ── Datei-Einbettungen ───────────────────────────────────────────────

const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "heic"]);

export function embedMarkup(fileName: string): string {
  const ext = (fileName.split(".").pop() ?? "").toLowerCase();
  const target = `docs/${fileName}`;
  if (IMAGE_EXT.has(ext) || ext === "pdf") return `![[${target}]]`;
  return `[[${target}]]`;
}

/** Ersetzt nur den generierten Block zwischen den Markern.
 *  Fehlen die Marker (fremde Datei), wird nichts angefasst. */
export function replaceBetweenMarkers(
  content: string,
  replacement: string,
): { text: string; changed: boolean } {
  let replaced = false;
  const next = transformMocBlocks(content, (block, language) => {
    if (language !== null || replaced) return block;
    const start = block.indexOf(MOC_START);
    const end = block.indexOf(MOC_END);
    if (start === -1 || end === -1 || end < start) return block;
    replaced = true;
    return `${block.slice(0, start + MOC_START.length)}\n${replacement}\n${block.slice(end)}`;
  });
  return { text: next, changed: next !== content };
}

// ── Quote-Header (Termin-Kopf) ─────────────────────────────────────────
// Der Body beginnt per Template mit zwei `> `-Zeilen (Titel + Zeit). In der
// App sind die reines Anzeige-Metadatum — der Editor zeigt nur den Rest,
// beim Speichern wird der Kopf wieder vorangestellt. split/join ist exakt
// invers (Template-Roundtrip ist byte-identisch), Fremd-Notizen ohne Kopf
// (head === "") bleiben unangetastet.

const QUOTE_HEAD_RE = /^((?:>[^\n]*\n)+)/;

/** Teilt führende `>`-Zeilen (plus genau eine Leerzeile) vom Rest-Body. */
export function splitQuoteHead(body: string): { head: string; rest: string } {
  const m = body.match(QUOTE_HEAD_RE);
  if (!m) return { head: "", rest: body };
  let rest = body.slice(m[1].length);
  if (rest.startsWith("\n")) rest = rest.slice(1);
  return { head: m[1], rest };
}

/** Fügt Kopf + Rest wieder zusammen (ggf. doppelte Kopf-Zeilen im Rest raus). */
export function joinQuoteHead(head: string, rest: string): string {
  const clean = splitQuoteHead(rest).rest;
  if (!head) return clean;
  return clean ? `${head}\n${clean}` : head;
}

/** Reiner Einfüge-Helfer für das Textarea (Cursor-Position bleibt steuerbar). */
export function insertAtCursor(
  text: string,
  start: number,
  end: number,
  insert: string,
): { text: string; cursor: number } {
  const s = Math.max(0, Math.min(start, text.length));
  const e = Math.max(s, Math.min(end, text.length));
  const block = insert.startsWith("\n") || s === 0 || text[s - 1] === "\n" ? insert : `\n${insert}`;
  const next = `${text.slice(0, s)}${block}${text.slice(e)}`;
  return { text: next, cursor: s + block.length };
}
