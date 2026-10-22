import { join } from "@tauri-apps/api/path";
import type { AppConfig, StudyEvent } from "./types";
import { apiListDocs, apiReadText } from "./storage";
import { parseNote } from "./notes";
import { buildFaecher } from "./ical";
import { subjectFileName } from "./filenames";
import { readIndex, validateRelativePath } from "./identity";
import { MAX_KNOWLEDGE_BYTES, MAX_KNOWLEDGE_NOTES, knowledgePath, parseKnowledgeNote, subjectKnowledgePaths, type KnowledgeCatalog } from "./knowledge";

function normalized(value: unknown): string {
  return typeof value === "string" ? value.normalize("NFC").trim().replace(/\s+/g, " ").toLocaleLowerCase("de") : "";
}

export async function loadKnowledge(cfg: Pick<AppConfig, "basisPfad" | "semester">, events: StudyEvent[]): Promise<KnowledgeCatalog> {
  const warnings: string[] = [];
  const paths = subjectKnowledgePaths(events, cfg.semester).map(({ path, key }) => ({ path, key: key as string | null }));
  const subjects = buildFaecher(events);
  const directories = new Map<string, { key: string | null; excluded: Set<string> }>([["Studium", { key: null, excluded: new Set() }]]);
  const addDirectory = (relative: string, depth: number, key: string, excluded: string[]) => {
    try {
      knowledgePath(relative);
      if (relative.split("/").length !== depth || relative.split("/").some((part) => ["docs", "history", "trash"].includes(part))) throw new Error("Ungültiger Wissensordner.");
      const current = directories.get(relative);
      if (current) {
        if (current.key !== key && current.key !== null) {
          current.key = null;
          warnings.push("Ein Wissensordner ist mehreren Fächern zugeordnet; seine Notizen bleiben ohne Fachzuordnung.");
        }
        excluded.forEach((name) => current.excluded.add(name));
      } else directories.set(relative, { key, excluded: new Set(excluded) });
    } catch { warnings.push("Ein ungültiger Fach- oder Terminordner wurde beim Einlesen ausgelassen."); }
  };
  for (const subject of subjects) {
    addDirectory(`${cfg.semester}/${subject.dir}`, 2, subject.key, [subject.file ?? subjectFileName(subject.name), subjectFileName(subject.name)]);
  }
  for (const event of [...events].sort((a, b) => a.terminRel.localeCompare(b.terminRel) || a.fachKey.localeCompare(b.fachKey))) {
    const subject = subjects.find((candidate) => candidate.key === event.fachKey)!;
    const excluded = [subject.file ?? subjectFileName(subject.name), subjectFileName(subject.name), ...(event.subjectFile ? [event.subjectFile] : [])];
    addDirectory(`${cfg.semester}/${event.fachDir}`, 2, event.fachKey, excluded);
    if (event.subjectDir) addDirectory(`${cfg.semester}/${event.subjectDir}`, 2, event.fachKey, excluded);
    if (event.terminRel.startsWith(`${event.fachDir}/`)) {
      addDirectory(`${cfg.semester}/${event.terminRel}`, 3, event.fachKey, [event.noteFile ?? "notes.md"]);
    } else warnings.push("Ein Terminordner passt nicht zum Fach und wurde beim Einlesen ausgelassen.");
  }
  if (subjects.length) {
    try {
      validateRelativePath(cfg.semester, 1);
      const index = readIndex(await apiReadText(await join(cfg.basisPfad, cfg.semester, ".mci-manager", "event-paths.json")));
      for (const relative of [...new Set(Object.values(index.paths))].sort()) {
        const key = directories.get(`${cfg.semester}/${relative.split("/")[0]}`)?.key;
        if (key) addDirectory(`${cfg.semester}/${relative}`, 3, key, [index.files[relative] ?? "notes.md"]);
      }
    } catch { warnings.push("Der Terminpfad-Index konnte nicht sicher gelesen werden. Notizen aktueller Termine bleiben verfügbar."); }
  }
  for (const [directory, { key, excluded }] of directories) {
    try {
      const entries = await apiListDocs(await join(cfg.basisPfad, directory));
      for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name, "de"))) {
        if (!entry.name.endsWith(".md") || entry.name.startsWith(".") || excluded.has(entry.name)) continue;
        if (entry.name.includes("/") || entry.name.includes("\\") || entry.size > MAX_KNOWLEDGE_BYTES) {
          warnings.push("Eine Studiennotiz wurde wegen ihres Dateinamens oder ihrer Größe übersprungen.");
          continue;
        }
        try { paths.push({ path: knowledgePath(`${directory}/${entry.name}`), key }); }
        catch { warnings.push("Eine Studiennotiz wurde wegen eines ungültigen Dateinamens übersprungen."); }
      }
    } catch { warnings.push(`Der Ordner „${directory}“ konnte nicht gelesen werden. Die übrigen Notizen bleiben verfügbar.`); }
  }
  const byName = new Map<string, Set<string>>();
  const byLv = new Map<string, Set<string>>();
  for (const event of events) {
    for (const name of [event.fach, subjects.find((subject) => subject.key === event.fachKey)!.name]) {
      const keys = byName.get(normalized(name)) ?? new Set();
      keys.add(event.fachKey);
      byName.set(normalized(name), keys);
    }
    if (normalized(event.lvNummer)) {
      const keys = byLv.get(normalized(event.lvNummer)) ?? new Set();
      keys.add(event.fachKey);
      byLv.set(normalized(event.lvNummer), keys);
    }
  }
  const inferredSubject = (data: Record<string, unknown>, path: string): string | null => {
    const hints = [normalized(data.fach), normalized(data.lv)];
    const matches = hints.map((hint, index) => hint ? (index === 0 ? byName : byLv).get(hint) ?? new Set<string>() : null).filter((keys) => keys !== null);
    if (!matches.length) return null;
    const keys = new Set(matches.flatMap((matches) => [...matches]));
    if (matches.every((matches) => matches.size === 1) && keys.size === 1) return [...keys][0];
    if (keys.size > 1 || (matches.length > 1 && keys.size > 0)) {
      warnings.push(`„${path.split("/").slice(-1)[0]}“ hat keine eindeutige Fachzuordnung; bitte Fach und LV-Angabe prüfen.`);
    }
    return null;
  };
  const notes: KnowledgeCatalog["notes"] = [];
  const candidates = [...new Map(paths.map((entry) => [entry.path, entry])).values()];
  if (candidates.length > MAX_KNOWLEDGE_NOTES) warnings.push(`Es werden höchstens ${MAX_KNOWLEDGE_NOTES} Wissensnotizen geladen.`);
  const unique = candidates.slice(0, MAX_KNOWLEDGE_NOTES);
  for (let offset = 0; offset < unique.length; offset += 8) {
    await Promise.all(unique.slice(offset, offset + 8).map(async ({ path, key }) => {
      try {
        const raw = await apiReadText(await join(cfg.basisPfad, path));
        if (raw === null) return;
        const { data } = parseNote(raw);
        if (data.uid !== undefined) return;
        let subjectKey = key;
        if (data.sakai_sync === "v1") {
          if (data.sakai_semester !== cfg.semester) return;
          if (typeof data.sakai_subject_key === "string") {
            if (!events.some((event) => event.fachKey === data.sakai_subject_key)) return;
            subjectKey = data.sakai_subject_key;
          }
        } else if ([data.semester, data.pruefungssemester].some((value) => value !== undefined && normalized(value) !== normalized(cfg.semester))) {
          subjectKey = null;
        } else if (path.startsWith("Studium/")) {
          subjectKey = inferredSubject(data, path);
        }
        const note = parseKnowledgeNote(raw, path, subjectKey);
        if (note) notes.push(note);
      } catch { warnings.push(`„${path.split("/").slice(-1)[0]}“ konnte nicht sicher gelesen werden. Bitte Dateiformat und Hinweise in Obsidian prüfen.`); }
    }));
  }
  notes.sort((a, b) => a.title.localeCompare(b.title, "de"));
  return { notes, warnings };
}
