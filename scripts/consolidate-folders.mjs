import { execFile } from "node:child_process";
import { lstat, open, readFile, realpath, rename } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { parseIcs } from "../src/lib/ical.ts";
import { planFolderConsolidation, rewriteMovedLinks } from "../src/lib/folderConsolidation.ts";
import {
  backupDirectory, backupOriginal, digest, exclusiveWrite, inside, inspectFile, key, makeParents,
  noSymlinkPath, refuse, snapshot,
} from "./migrate-vault.mjs";

const USAGE = `node scripts/consolidate-folders.mjs --vault /absolute/vault --semester Sem01 --calendar /absolute/calendar.ics [--dry-run]
Apply: --apply --backup /absolute/new-empty-backup statt --dry-run.
Fasst Fachordner auf genau einen Ordner pro Fach und Lehrform zusammen. Standard ist ein Probelauf ohne Schreibzugriff.
Vor --apply: alle Notiz-Entwürfe in der App sichern, dann Obsidian und study-manager beenden.
Das Backup enthält original/, plan.json und journal.jsonl.`;

function argumentsFor(argv) {
  const options = { apply: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help") return { help: true };
    if (arg === "--apply" || arg === "--dry-run") {
      if (options.mode) refuse("Modus mehrfach angegeben.");
      options.mode = arg;
      options.apply = arg === "--apply";
    } else if (["--vault", "--semester", "--calendar", "--backup"].includes(arg)) {
      const name = arg.slice(2);
      if (options[name] !== undefined || !argv[i + 1] || argv[i + 1].startsWith("--")) refuse("Argument fehlt oder wurde mehrfach angegeben.");
      options[name] = argv[++i];
    } else refuse("Unbekanntes Argument; --help zeigt die Verwendung.");
  }
  if (!options.vault || !options.semester || !options.calendar || (options.apply && !options.backup)) {
    refuse("Explizite --vault, --semester, --calendar und bei --apply zusätzlich --backup erforderlich.");
  }
  for (const name of ["vault", "calendar", "backup"]) {
    if (options[name] && !path.isAbsolute(options[name])) refuse("Vault, Kalender und Backup benötigen absolute Pfade.");
  }
  return options;
}

const execFileAsync = promisify(execFile);

/**
 * study-manager must be closed. Obsidian may stay open for other vaults; when its vault registry
 * cannot prove that this vault is closed, the vault counts as open.
 */
export async function vaultClosed(vault) {
  if (process.platform !== "darwin") return;
  const { stdout } = await execFileAsync("/bin/ps", ["-axo", "comm="], { maxBuffer: 8 * 1024 * 1024 });
  const running = stdout.split("\n").map((command) => path.basename(command.trim()));
  if (running.some((name) => /^study[-_ ]manager(?:\.app)?$/i.test(name))) refuse("study-manager muss vor --apply beendet sein.");
  if (!running.some((name) => /^obsidian(?: helper.*)?(?:\.app)?$/i.test(name))) return;
  let open = true;
  try {
    const registry = JSON.parse(await readFile(path.join(homedir(), "Library", "Application Support", "obsidian", "obsidian.json"), "utf8"));
    const entries = Object.values(registry.vaults);
    const paths = await Promise.all(entries.map(async (entry) => entry.open === true ? key(await realpath(entry.path).catch(() => entry.path)) : null));
    open = paths.some((candidate) => candidate !== null && (inside(candidate, key(vault)) || inside(key(vault), candidate)));
  } catch { open = true; }
  if (open) refuse("Obsidian hat diesen Vault geöffnet; bitte Obsidian vor --apply beenden.");
}

const hidden = (rel) => rel.split("/").some((part) => part.startsWith("."));

function semesterEntries(entries, semester) {
  const prefix = `${semester}/`;
  const result = [];
  for (const [rel, record] of Object.entries(entries)) {
    if (!rel.startsWith(prefix)) continue;
    const inner = rel.slice(prefix.length);
    const depth = inner.split("/").length;
    if (hidden(inner) || depth > 2) continue;
    result.push({ path: inner, kind: record.kind === "directory" ? "dir" : "file" });
  }
  return result;
}

async function excludedSubjects(vault, semester) {
  const file = path.join(vault, semester, ".mci-manager", "excluded-subjects.json");
  let raw;
  try { raw = await readFile(file, "utf8"); }
  catch (error) { if (error.code === "ENOENT") return new Set(); throw error; }
  const value = JSON.parse(raw);
  if (!value || value.version !== 1 || !Array.isArray(value.subjectKeys)) refuse("excluded-subjects.json hat ein unbekanntes Format.");
  return new Set(value.subjectKeys);
}

/** Semester-relative location of an entry after applying the moves in execution order. */
function finalPath(rel, moves) {
  let current = rel;
  for (const move of moves) {
    if (current === move.from || current.startsWith(`${move.from}/`)) current = `${move.to}${current.slice(move.from.length)}`;
  }
  return current;
}

function rewrites(original, semester, plan) {
  const result = [];
  for (const [rel, content] of original.texts) {
    if (!rel.endsWith(".md") || hidden(rel)) continue;
    const next = rewriteMovedLinks(content, semester, plan.links);
    if (next === content) continue;
    const inSemester = rel.startsWith(`${semester}/`);
    const target = inSemester ? `${semester}/${finalPath(rel.slice(semester.length + 1), plan.moves)}` : rel;
    result.push({ source: rel, path: target, before: original.entries[rel].hash, content: next });
  }
  return result;
}

function describe(plan, edits, skippedSakai) {
  const lines = [`Probelauf für ${plan.semester}: ${plan.folders.length} Ordner nach Fach und Lehrform`, ""];
  for (const folder of plan.folders) {
    lines.push(`- ${folder.dir}  (${folder.title})`);
    for (const source of folder.sources) lines.push(`    aus ${source}`);
  }
  lines.push("", `Verschiebungen (${plan.moves.length}):`);
  for (const move of plan.moves) lines.push(`- [${move.kind}] ${move.from}  ->  ${move.to}`);
  lines.push("", `In den Vault-Papierkorb, weil danach leer (${plan.trash.length}):`);
  for (const dir of plan.trash) lines.push(`- ${dir}`);
  lines.push("", `Bleibt unverändert (${plan.kept.length}):`);
  for (const entry of plan.kept) lines.push(`- ${entry.path}: ${entry.reason}`);
  lines.push("", `Notizen mit angepassten Links: ${edits.length}`);
  for (const edit of edits) lines.push(`- ${edit.path}`);
  if (skippedSakai.length) {
    lines.push("", "Sakai-Notizen mit alten Pfaden (geschützt, die App aktualisiert sie beim nächsten Sakai-Abruf):");
    for (const rel of skippedSakai) lines.push(`- ${rel}`);
  }
  lines.push("", `Index: ${Object.keys(plan.index.paths).length} Termine, ${Object.keys(plan.index.subjects).length} Ordnerschlüssel`);
  return lines.join("\n");
}

async function multiset(vault, semester) {
  const { entries } = await snapshot(vault, semester);
  return Object.entries(entries).filter(([, record]) => record.kind === "file").map(([, record]) => record.hash).sort();
}

async function writeChecked(vault, rel, expectedHash, content) {
  const absolute = await noSymlinkPath(path.join(vault, rel));
  if ((await inspectFile(absolute)).record.hash !== expectedHash) refuse(`Datei wurde seit der Planung geändert: ${rel}`);
  const temp = `${absolute}.consolidate-${process.pid}`;
  await exclusiveWrite(temp, content);
  await rename(temp, absolute);
  if ((await inspectFile(absolute)).record.hash !== digest(content)) refuse(`Geschriebene Bytes stimmen nicht: ${rel}`);
}

async function moveChecked(vault, from, to) {
  const source = await noSymlinkPath(path.join(vault, from));
  await makeParents(vault, to);
  const target = await noSymlinkPath(path.join(vault, to), true);
  try { await lstat(target); refuse(`Ziel existiert bereits: ${to}`); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  await rename(source, target);
}

export async function runConsolidation(argv) {
  const options = argumentsFor(argv);
  if (options.help) {
    console.log(USAGE);
    return;
  }
  const vault = await noSymlinkPath(options.vault);
  if (inside(key(vault), key(process.cwd())) || inside(key(vault), key(homedir()))) {
    refuse("Vault muss ein spezifisches Verzeichnis sein, kein System-, Home- oder Arbeitsverzeichnis-Vorfahre.");
  }
  if (!(await lstat(vault)).isDirectory() || await realpath(vault) !== vault) refuse("Vault muss ein echtes Verzeichnis sein.");
  const calendar = await inspectFile(await noSymlinkPath(options.calendar), true);
  const events = parseIcs(calendar.content);
  if (!events.length) refuse("Ein leerer Kalender ist keine sichere Grundlage.");
  const original = await snapshot(vault, options.semester);
  const indexRel = `${options.semester}/.mci-manager/event-paths.json`;
  const rawIndex = original.texts.get(indexRel);
  if (rawIndex === undefined) refuse("Terminpfad-Index fehlt.");
  const plan = planFolderConsolidation({
    semester: options.semester, rawIndex, events,
    excludedSubjectKeys: await excludedSubjects(vault, options.semester),
    entries: semesterEntries(original.entries, options.semester),
  });
  const edits = rewrites(original, options.semester, plan);
  const skippedSakai = [...original.texts].filter(([rel, content]) => rel.endsWith(".md") && content.includes("<!-- sm:sakai:")
    && plan.links.some(([from]) => content.includes(`${options.semester}/${from}`))).map(([rel]) => rel);
  console.log(describe(plan, edits, skippedSakai));
  if (!options.apply) return;
  if (!plan.moves.length && !plan.trash.length) {
    console.log("\nNichts zu tun.");
    return;
  }

  await vaultClosed(vault);
  const backup = await backupDirectory(options.backup, vault);
  await backupOriginal(vault, backup, original.entries);
  await exclusiveWrite(path.join(backup, "plan.json"), `${JSON.stringify({ ...plan, edits: edits.map(({ source, path: target }) => ({ source, path: target })) }, null, 2)}\n`);
  const before = await multiset(vault, options.semester);
  const revision = new Date().toISOString().replace(/[:.]/g, "-");
  const journal = await open(path.join(backup, "journal.jsonl"), "wx", 0o600);
  const record = async (entry) => { await journal.write(`${JSON.stringify(entry)}\n`); await journal.sync(); };
  try {
    await vaultClosed(vault);
    for (const move of plan.moves) {
      await moveChecked(vault, `${options.semester}/${move.from}`, `${options.semester}/${move.to}`);
      await record({ phase: "moved", ...move });
    }
    for (const dir of plan.trash) {
      const to = `.mci-manager/trash/${revision}/${options.semester}/${dir}`;
      await moveChecked(vault, `${options.semester}/${dir}`, to);
      await record({ phase: "trashed", from: dir, to });
    }
    for (const edit of edits) {
      await writeChecked(vault, edit.path, edit.before, edit.content);
      await record({ phase: "rewritten", path: edit.path });
    }
    await writeChecked(vault, indexRel, original.entries[indexRel].hash, plan.rawIndex);
    await record({ phase: "index" });

    const expected = [...before];
    const drop = (hash) => expected.splice(expected.indexOf(hash), 1);
    for (const edit of edits) { drop(edit.before); expected.push(digest(edit.content)); }
    drop(original.entries[indexRel].hash);
    expected.push(digest(plan.rawIndex));
    expected.sort();
    const after = await multiset(vault, options.semester);
    if (JSON.stringify(after) !== JSON.stringify(expected)) refuse("Abschlussprüfung: Dateibestand weicht vom Plan ab.");
    await record({ phase: "verified", files: after.length });
  } catch (error) {
    await record({ phase: "stopped" }).catch(() => {});
    throw error;
  } finally { await journal.close(); }
  console.log(`\nAngewendet und geprüft: ${plan.moves.length} Verschiebungen, ${plan.trash.length} Ordner im Papierkorb, ${edits.length} Notizen angepasst. Backup: ${backup}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runConsolidation(process.argv.slice(2)).catch((error) => {
    const safe = error instanceof Error && error.message.startsWith("Migration abgebrochen:");
    console.error(safe ? error.message : `Zusammenführung abgebrochen: ${error instanceof Error ? error.message : "unbekannter Fehler"}`);
    process.exitCode = 1;
  });
}
