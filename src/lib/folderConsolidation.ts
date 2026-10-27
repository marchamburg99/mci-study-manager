import { subjectFileName } from "./filenames.ts";
import { folderKey, folderTitle, slug, subjectName } from "./ical.ts";
import { readIndex, validateRelativePath } from "./identity.ts";
import type { PathIndex } from "./identity.ts";
import type { StudyEvent } from "./types.ts";

/** One existing entry directly inside the semester folder or one of its subject folders. */
export interface SemesterEntry {
  /** Path relative to the semester folder, depth 1 (subject folder) or 2 (its children). */
  path: string;
  kind: "file" | "dir";
  /** For depth-1 folders: whether it contains anything besides .DS_Store. */
  empty?: boolean;
}

export interface FolderMove {
  from: string;
  to: string;
  kind: "session" | "entry" | "folder";
}

export interface FolderConsolidationPlan {
  semester: string;
  folders: Array<{ key: string; title: string; dir: string; sources: string[] }>;
  /** Filesystem moves relative to the semester folder, in execution order; folder renames come last. */
  moves: FolderMove[];
  /** Subject folders that are empty after the moves and go to the vault trash. */
  trash: string[];
  /** Entries that stay where they are, with the reason. */
  kept: Array<{ path: string; reason: string }>;
  /** Semester-relative path prefixes whose links must follow the move. */
  links: Array<[string, string]>;
  index: PathIndex;
  rawIndex: string;
}

const pathKey = (value: string) => value.normalize("NFC").toLowerCase();
const dirOf = (path: string) => path.split("/")[0];
const leafOf = (path: string) => path.slice(path.indexOf("/") + 1);
const numberOf = (dir: string) => Number(dir.match(/^(\d+)-/)?.[1] ?? Number.MAX_SAFE_INTEGER);

function folderSlug(event: StudyEvent): string {
  return slug(folderTitle(event.fach, event.typ));
}

/** Folder name stem without number, lecturer suffix and the "Geleitetes Selbststudium" prefix. */
function dirStem(dir: string): string {
  return dir.replace(/^\d+-/, "").replace(/_.*$/, "").replace(/^geleitetes-selbststudium-/, "");
}

/**
 * Plans the move from one folder per index key generation to exactly one folder per subject and
 * course type. Session folders and loose files move into the fullest existing folder, empty
 * duplicates go to the trash, and that folder gets a clean `NN-subject-type` name. Excluded
 * subjects, unknown folders and anything that would overwrite an existing entry stay in place.
 */
export function planFolderConsolidation(input: {
  semester: string;
  rawIndex: string;
  events: StudyEvent[];
  excludedSubjectKeys: ReadonlySet<string>;
  entries: SemesterEntry[];
}): FolderConsolidationPlan {
  const { semester } = input;
  validateRelativePath(semester, 1);
  const index = readIndex(input.rawIndex);
  const active = input.events.filter((event) => !input.excludedSubjectKeys.has(event.fachKey));
  const byUid = new Map(active.map((event) => [event.uid, event]));
  const byKey = new Map<string, StudyEvent>();
  for (const event of active) if (!byKey.has(folderKey(event))) byKey.set(folderKey(event), event);

  const dirs = input.entries.filter((entry) => entry.kind === "dir" && !entry.path.includes("/")).map((entry) => entry.path);
  const children = new Map(dirs.map((dir) => [dir, input.entries.filter((entry) => entry.path.startsWith(`${dir}/`))]));
  const sessionPaths = new Map(Object.entries(index.paths).map(([uid, path]) => [pathKey(path), uid]));
  const exists = new Set(input.entries.map((entry) => pathKey(entry.path)));
  const kept: FolderConsolidationPlan["kept"] = [];

  // Each existing subject folder belongs to the course type its name or its sessions name.
  const dirKey = new Map<string, string>();
  for (const dir of dirs) {
    const stem = dirStem(dir);
    const byName = [...byKey].filter(([, event]) => {
      const candidate = folderSlug(event);
      return candidate === stem || (stem.length >= 12 && candidate.startsWith(stem));
    }).map(([key]) => key);
    const indexed = new Set(Object.entries(index.subjects).filter(([, path]) => path === dir).map(([key]) => key));
    const narrowed = byName.length > 1 ? byName.filter((key) => indexed.has(byKey.get(key)!.fachKey)) : byName;
    if (narrowed.length === 1) {
      dirKey.set(dir, narrowed[0]);
      continue;
    }
    const votes = new Map<string, number>();
    for (const [path, uid] of Object.entries(index.paths).map(([uid, path]) => [path, uid] as const)) {
      const event = byUid.get(uid);
      if (event && dirOf(path) === dir) votes.set(folderKey(event), (votes.get(folderKey(event)) ?? 0) + 1);
    }
    const ranked = [...votes].sort((a, b) => b[1] - a[1]);
    if (ranked.length && (ranked.length === 1 || ranked[0][1] > ranked[1][1])) dirKey.set(dir, ranked[0][0]);
    else kept.push({ path: dir, reason: "Ordner lässt sich keinem aktiven Fach mit Lehrform eindeutig zuordnen" });
  }

  // The fullest folder of a course type becomes its home; ties keep the lower number.
  const sessionsIn = (dir: string, key: string) => (children.get(dir) ?? []).filter((entry) => {
    const uid = sessionPaths.get(pathKey(entry.path));
    return entry.kind === "dir" && uid !== undefined && byUid.get(uid) !== undefined && folderKey(byUid.get(uid)!) === key;
  }).length;
  const homes = new Map<string, string>();
  for (const key of new Set(dirKey.values())) {
    const candidates = dirs.filter((dir) => dirKey.get(dir) === key);
    candidates.sort((a, b) => sessionsIn(b, key) - sessionsIn(a, key)
      || (children.get(b)?.length ?? 0) - (children.get(a)?.length ?? 0) || numberOf(a) - numberOf(b) || a.localeCompare(b));
    homes.set(key, candidates[0]);
  }

  // A course type that only shares an older folder with another type gets a folder of its own.
  const newHomes = new Set<string>();
  for (const uid of Object.keys(index.paths)) {
    const event = byUid.get(uid);
    if (event && !homes.has(folderKey(event))) newHomes.add(folderKey(event));
  }

  // Clean names, numbered by title, unless the name is taken by a folder that stays.
  const titles = [...homes.keys(), ...newHomes].map((key) => ({ key, title: folderTitle(byKey.get(key)!.fach, byKey.get(key)!.typ) }))
    .sort((a, b) => a.title.localeCompare(b.title, "de") || a.key.localeCompare(b.key));
  const finalDir = new Map<string, string>();
  const existingHomes = new Set(homes.values());
  const staying = new Set(dirs.filter((dir) => !dirKey.has(dir)).map(pathKey));
  titles.forEach(({ key, title }, i) => {
    const clean = `${String(i + 1).padStart(2, "0")}-${slug(title) || "fach"}`;
    if (newHomes.has(key)) {
      let dir = clean;
      for (let suffix = 2; dirs.some((other) => pathKey(other) === pathKey(dir)); suffix++) dir = `${clean}-${suffix}`;
      homes.set(key, dir);
      finalDir.set(dir, dir);
      return;
    }
    const home = homes.get(key)!;
    const taken = staying.has(pathKey(clean)) || (dirs.some((dir) => pathKey(dir) === pathKey(clean)) && !existingHomes.has(clean));
    finalDir.set(home, taken ? home : clean);
  });
  const homeDirs = new Set(homes.values());

  const moves: FolderMove[] = [];
  const claimed = new Set<string>();
  const place = (dir: string, leaf: string) => {
    let candidate = `${dir}/${leaf}`;
    let suffix = 2;
    while (claimed.has(pathKey(candidate)) || (exists.has(pathKey(candidate)) && !moves.some((move) => pathKey(move.from) === pathKey(candidate)))) {
      candidate = `${dir}/${leaf}-${suffix++}`;
    }
    claimed.add(pathKey(candidate));
    return candidate;
  };
  for (const entry of input.entries) if (entry.path.includes("/")) {
    const home = homes.get(dirKey.get(dirOf(entry.path)) ?? "");
    if (home === dirOf(entry.path)) claimed.add(pathKey(entry.path));
  }

  // Sessions follow their own course type, wherever they currently are. Sessions that left the
  // calendar follow the course type of the folder they are in; excluded subjects stay.
  const paths = { ...index.paths };
  const excludedUids = new Set(input.events.filter((event) => input.excludedSubjectKeys.has(event.fachKey)).map((event) => event.uid));
  const homeOfUid = (uid: string, path: string) => {
    const event = byUid.get(uid);
    const key = event ? folderKey(event) : excludedUids.has(uid) ? undefined : dirKey.get(dirOf(path));
    return key === undefined ? undefined : homes.get(key);
  };
  // Paths that stay, including reserved paths without a folder yet, must never be handed out twice.
  for (const [uid, path] of Object.entries(index.paths)) {
    const home = homeOfUid(uid, path);
    if (!home || dirOf(path) === home) claimed.add(pathKey(path));
  }
  for (const path of index.reserved) if (homeDirs.has(dirOf(path))) claimed.add(pathKey(path));
  for (const [uid, path] of Object.entries(index.paths).sort(([, a], [, b]) => a.localeCompare(b))) {
    const home = homeOfUid(uid, path);
    if (!home || dirOf(path) === home) continue;
    const next = place(home, leafOf(path));
    paths[uid] = next;
    if (exists.has(pathKey(path))) moves.push({ from: path, to: next, kind: "session" });
  }

  // Other entries of a duplicate folder join its home unless that would overwrite something.
  const trash: string[] = [];
  for (const dir of dirs) {
    const key = dirKey.get(dir);
    const home = key === undefined ? undefined : homes.get(key);
    const rest = (children.get(dir) ?? []).filter((entry) => !moves.some((move) => move.from === entry.path)
      && !(sessionPaths.has(pathKey(entry.path)) && paths[sessionPaths.get(pathKey(entry.path))!] === entry.path))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    if (home !== undefined && home !== dir) {
      for (const entry of rest) {
        const target = `${home}/${leafOf(entry.path)}`;
        if (claimed.has(pathKey(target)) || exists.has(pathKey(target))) {
          kept.push({ path: entry.path, reason: `Ziel ${target} existiert bereits` });
          continue;
        }
        claimed.add(pathKey(target));
        moves.push({ from: entry.path, to: target, kind: "entry" });
      }
    }
    const remaining = (children.get(dir) ?? []).filter((entry) => !moves.some((move) => move.from === entry.path));
    const holdsSessions = Object.values(paths).some((path) => dirOf(path) === dir);
    if (!homeDirs.has(dir) && remaining.length === 0 && !holdsSessions) trash.push(dir);
  }

  // Rename homes last, so every earlier move targets the old home path.
  const renamed = (path: string) => {
    const next = finalDir.get(dirOf(path));
    return next === undefined ? path : `${next}${path.slice(dirOf(path).length)}`;
  };
  const execution: FolderMove[] = [...moves];
  for (const [home, next] of finalDir) if (home !== next) execution.push({ from: home, to: next, kind: "folder" });
  for (const uid of Object.keys(paths)) paths[uid] = renamed(paths[uid]);

  const trashed = new Set(trash.map(pathKey));
  const files: Record<string, string> = {};
  for (const [uid, path] of Object.entries(index.paths)) {
    const file = index.files[path];
    if (file !== undefined) files[paths[uid]] = file;
  }
  for (const [path, file] of Object.entries(index.files)) {
    if (!Object.values(index.paths).includes(path) && !trashed.has(pathKey(dirOf(path)))) files[renamed(path)] = file;
  }
  const subjects: Record<string, string> = {};
  const subjectFiles: Record<string, string> = {};
  const finalEntries = new Set(input.entries.map((entry) => {
    const move = moves.find((candidate) => candidate.from === entry.path);
    return pathKey(renamed(move ? move.to : entry.path));
  }));
  for (const [key, home] of homes) {
    const dir = finalDir.get(home)!;
    subjects[key] = dir;
    const event = byKey.get(key)!;
    const sourceDirs = dirs.filter((candidate) => dirKey.get(candidate) === key);
    const names = [...Object.entries(index.subjectFiles).filter(([oldKey]) => sourceDirs.includes(index.subjects[oldKey] ?? "")).map(([, file]) => file),
      subjectFileName(subjectName(event.fach)), subjectFileName(folderTitle(event.fach, event.typ))];
    const file = names.find((name) => finalEntries.has(pathKey(`${dir}/${name}`)));
    if (file) subjectFiles[key] = file;
  }
  for (const [key, dir] of Object.entries(index.subjects)) {
    if (subjects[key] !== undefined || trashed.has(pathKey(dir)) || dirKey.has(dir)) continue;
    subjects[key] = dir;
    if (index.subjectFiles[key] !== undefined) subjectFiles[key] = index.subjectFiles[key];
  }
  const reserved = [...new Set([...Object.values(paths),
    ...index.reserved.filter((path) => !trashed.has(pathKey(dirOf(path))) && !Object.values(index.paths).includes(path)).map(renamed)])];

  const sorted = (record: Record<string, string>) => Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));
  const next: PathIndex = { version: 2, paths: sorted(paths), subjects: sorted(subjects), reserved: reserved.sort(),
    files: sorted(files), subjectFiles: sorted(subjectFiles) };
  const rawIndex = `${JSON.stringify(next, null, 2)}\n`;
  readIndex(rawIndex);

  const links: Array<[string, string]> = execution.flatMap((move): Array<[string, string]> => {
    const to = move.kind === "folder" ? move.to : renamed(move.to);
    return /\.md$/i.test(move.from) ? [[move.from, to], [move.from.slice(0, -3), to.slice(0, -3)]] : [[move.from, to]];
  });
  // Sessions whose folder does not exist yet are still linked from overviews and notes.
  for (const [uid, path] of Object.entries(index.paths)) {
    if (paths[uid] !== path && !links.some(([from]) => from === path)) links.push([path, paths[uid]]);
  }
  // Markdown links encode spaces; wikilinks keep them.
  const encode = (value: string) => value.replace(/ /g, "%20");
  links.push(...links.filter(([from]) => from.includes(" ")).map(([from, to]): [string, string] => [encode(from), encode(to)]));
  return {
    semester,
    folders: [...homes].map(([key, home]) => ({ key, title: folderTitle(byKey.get(key)!.fach, byKey.get(key)!.typ),
      dir: finalDir.get(home)!, sources: dirs.filter((dir) => dirKey.get(dir) === key) })).sort((a, b) => a.dir.localeCompare(b.dir)),
    moves: execution,
    trash,
    kept,
    links,
    index: next,
    rawIndex,
  };
}

/** Rewrites semester-relative link targets after a consolidation; generated Sakai notes stay untouched. */
export function rewriteMovedLinks(content: string, semester: string, links: Array<[string, string]>): string {
  if (!links.length || content.includes("<!-- sm:sakai:")) return content;
  const map = new Map(links.map(([from, to]) => [from, to]));
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const alternatives = [...map.keys()].sort((a, b) => b.length - a.length).map(escape).join("|");
  const pattern = new RegExp(`(?<=(?:\\[\\[|\\]\\(|\\(|^)${escape(semester)}/|\\[\\[|\\]\\()(${alternatives})(?=[/|\\]#)]|\\.md|$)`, "gm");
  return content.replace(pattern, (match) => map.get(match) ?? match);
}
