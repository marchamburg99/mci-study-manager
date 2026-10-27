import { constants } from "node:fs";
import { copyFile, lstat, mkdir, open, readdir, realpath, unlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { parseIcs } from "../src/lib/ical.ts";
import { planVaultMigration } from "../src/lib/vaultMigration.ts";

const execFileAsync = promisify(execFile);
export const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const inside = (parent, child) => child === parent || child.startsWith(`${parent}${path.sep}`);
export const key = (value) => value.normalize("NFC").toLowerCase();

export function refuse(message) {
  throw new Error(`Migration abgebrochen: ${message}`);
}

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

export async function noSymlinkPath(absolute, allowMissingLeaf = false) {
  const resolved = path.resolve(absolute);
  const parsed = path.parse(resolved);
  let current = parsed.root;
  const parts = resolved.slice(parsed.root.length).split(path.sep).filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    let stat;
    try { stat = await lstat(current); }
    catch (error) {
      if (error.code === "ENOENT" && allowMissingLeaf && i === parts.length - 1) return resolved;
      throw error;
    }
    if (stat.isSymbolicLink()) refuse("Symlinks sind nicht erlaubt.");
    if (i < parts.length - 1 && !stat.isDirectory()) refuse("Pfadkomponente ist kein Verzeichnis.");
  }
  return resolved;
}

const signature = (stat) => ({ size: Number(stat.size), mtime: stat.mtimeNs.toString(), ctime: stat.ctimeNs.toString(),
  ino: stat.ino.toString(), dev: stat.dev.toString(), mode: Number(stat.mode) });
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export async function inspectFile(absolute, text = false) {
  const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) refuse("Nur reguläre Dateien sind erlaubt.");
    const hash = createHash("sha256");
    const chunks = [];
    for await (const bytes of handle.createReadStream({ autoClose: false })) {
      hash.update(bytes);
      if (text) chunks.push(bytes);
    }
    if (!same(signature(before), signature(await handle.stat({ bigint: true })))) refuse("Datei wurde während des Lesens geändert.");
    const record = { ...signature(before), size: Number(before.size), hash: hash.digest("hex") };
    let content;
    if (text) {
      try { content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks)); }
      catch { refuse("Textdatei ist kein gültiges UTF-8."); }
    }
    return { record, content };
  } finally { await handle.close(); }
}

export async function snapshot(vault, semester) {
  const entries = {};
  const texts = new Map();
  const seen = new Set();
  const walk = async (rel) => {
    const absolute = path.join(vault, rel);
    const stat = await lstat(absolute);
    if (stat.isSymbolicLink()) refuse("Symlink im Vault gefunden.");
    if (rel) {
      if (seen.has(key(rel))) refuse("Dateikollision durch Großschreibung oder Unicode-Normalisierung.");
      seen.add(key(rel));
    }
    if (stat.isDirectory()) {
      entries[rel] = { kind: "directory", mode: stat.mode, ino: String(stat.ino), dev: String(stat.dev) };
      for (const child of (await readdir(absolute)).sort()) await walk(rel ? `${rel}/${child}` : child);
    } else if (stat.isFile()) {
      const isText = (!rel.split("/").some((part) => part.startsWith(".")) && rel.endsWith(".md")) || rel === `${semester}/.mci-manager/event-paths.json`;
      const read = await inspectFile(absolute, isText);
      entries[rel] = { kind: "file", ...read.record };
      if (isText) texts.set(rel, read.content);
    } else refuse("Nicht reguläre Datei im Vault gefunden.");
  };
  await walk("");
  return { entries, texts };
}

export async function appsClosed() {
  if (process.platform !== "darwin") return;
  const { stdout } = await execFileAsync("/bin/ps", ["-axo", "comm="], { maxBuffer: 8 * 1024 * 1024 });
  if (stdout.split("\n").some((command) => /^(?:obsidian(?: helper.*)?|study[-_ ]manager)(?:\.app)?$/i.test(path.basename(command.trim())))) {
    refuse("Obsidian und study-manager müssen vor --apply vollständig geschlossen sein.");
  }
}

export async function exclusiveWrite(file, content, mode = 0o600) {
  const handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
  try { await handle.writeFile(content); await handle.sync(); }
  finally { await handle.close(); }
}

export async function makeParents(root, rel) {
  let current = root;
  for (const part of path.dirname(rel).split(path.sep).filter((part) => part !== ".")) {
    current = path.join(current, part);
    try { await mkdir(current, { mode: 0o700 }); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
    const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) refuse("Unsichere Zielverzeichnisse.");
  }
}

async function assertFile(root, rel, expected) {
  await noSymlinkPath(path.join(root, rel));
  const actual = await inspectFile(path.join(root, rel));
  if (!same(actual.record, expected)) refuse("Dateisnapshot stimmt nicht mehr; konkurrierende Änderung erkannt.");
}

async function assertSnapshot(vault, semester, expected) {
  const actual = await snapshot(vault, semester);
  if (!same(actual.entries, expected)) refuse("Vault wurde seit der Planung verändert.");
}

export async function backupDirectory(requested, vault) {
  const backup = await noSymlinkPath(requested, true);
  if (inside(key(vault), key(backup)) || inside(key(backup), key(vault))
    || inside(key(backup), key(process.cwd())) || key(backup) === key(homedir())) {
    refuse("Backup muss ein eigenes, spezifisches Verzeichnis außerhalb des Vaults sein.");
  }
  try {
    const stat = await lstat(backup);
    if (!stat.isDirectory() || (await readdir(backup)).length) refuse("Backup-Ziel muss neu oder vollständig leer sein.");
    if ((stat.mode & 0o077) !== 0) refuse("Vorhandenes leeres Backup-Ziel benötigt private Rechte (0700).");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await mkdir(backup, { mode: 0o700 });
  }
  return backup;
}

export async function backupOriginal(vault, backup, entries) {
  const destination = path.join(backup, "original");
  await mkdir(destination, { mode: 0o700 });
  for (const [rel, record] of Object.entries(entries)) {
    if (!rel) continue;
    if (record.kind === "directory") await mkdir(path.join(destination, rel), { mode: 0o700 });
    else {
      const { kind: _kind, ...expected } = record;
      await assertFile(vault, rel, expected);
      await copyFile(path.join(vault, rel), path.join(destination, rel), constants.COPYFILE_EXCL);
      const copied = await inspectFile(path.join(destination, rel));
      if (copied.record.hash !== record.hash) refuse("Sicherungsprüfung fehlgeschlagen.");
    }
  }
}

function validateTargets(plan, entries) {
  const occupied = new Map(Object.keys(entries).map((rel) => [key(rel), rel]));
  for (const change of plan.changes) {
    if (change.path.startsWith(".obsidian/")) refuse(".obsidian darf nicht verändert werden.");
    if (change.kind === "archive") continue;
    const existing = occupied.get(key(change.path));
    if (existing !== undefined && !(change.kind === "write" && change.before !== null && existing === change.path)) {
      refuse("Ziel ist bereits durch eine Datei oder ein Verzeichnis belegt.");
    }
    for (let dir = path.posix.dirname(change.path); dir !== "."; dir = path.posix.dirname(dir)) {
      const occupiedDir = occupied.get(key(dir));
      if (occupiedDir !== undefined && (occupiedDir !== dir || entries[occupiedDir].kind !== "directory")) refuse("Zielverzeichnis kollidiert mit vorhandenen Daten.");
    }
  }
}

async function stagePlan(backup, plan, entries, calendarRecord) {
  await exclusiveWrite(path.join(backup, "plan.json"), `${JSON.stringify({ ...plan, files: undefined, calendarSnapshot: calendarRecord }, null, 2)}\n`);
  await exclusiveWrite(path.join(backup, "snapshot.json"), `${JSON.stringify(entries, null, 2)}\n`);
  await mkdir(path.join(backup, "staged"), { mode: 0o700 });
  await mkdir(path.join(backup, "archive"), { mode: 0o700 });
  for (const change of plan.changes) {
    if (change.kind === "archive") continue;
    await makeParents(path.join(backup, "staged"), change.path);
    await exclusiveWrite(path.join(backup, "staged", change.path), change.content);
    if ((await inspectFile(path.join(backup, "staged", change.path))).record.hash !== digest(change.content)) refuse("Staging-Prüfung fehlgeschlagen.");
  }
}

async function commitPlan(vault, backup, plan, entries) {
  const journal = await open(path.join(backup, "journal.jsonl"), "wx", 0o600);
  const record = async (entry) => { await journal.write(`${JSON.stringify(entry)}\n`); await journal.sync(); };
  try {
    for (const change of plan.changes) {
      await record({ phase: "begin", kind: change.kind, path: change.path, from: change.from });
      const source = change.kind === "rename" ? change.from : change.path;
      if (change.before !== null) {
        const { kind: _kind, ...expected } = entries[source];
        await assertFile(vault, source, expected);
        const archive = path.join(backup, "archive", source);
        await makeParents(path.join(backup, "archive"), source);
        await copyFile(path.join(vault, source), archive, constants.COPYFILE_EXCL);
        if ((await inspectFile(archive)).record.hash !== expected.hash) refuse("Archivprüfung fehlgeschlagen.");
        await assertFile(vault, source, expected);
        await unlink(path.join(vault, source));
        await record({ phase: "archived", path: source });
      }
      if (change.kind !== "archive") {
        await noSymlinkPath(vault);
        await makeParents(vault, change.path);
        await noSymlinkPath(path.join(vault, change.path), true);
        await copyFile(path.join(backup, "staged", change.path), path.join(vault, change.path), constants.COPYFILE_EXCL);
        if ((await inspectFile(path.join(vault, change.path))).record.hash !== digest(change.content)) refuse("Geschriebene Bytes entsprechen nicht dem Plan.");
        await record({ phase: "written", path: change.path, hash: digest(change.content) });
      }
      await record({ phase: "complete", kind: change.kind, path: change.path });
    }
    const final = await snapshot(vault, plan.semester);
    const expectedFiles = new Map(Object.entries(entries).filter(([, entry]) => entry.kind === "file").map(([rel, entry]) => [rel, entry.hash]));
    const modified = new Set();
    const expectedDirectories = new Set(Object.entries(entries).filter(([, entry]) => entry.kind === "directory").map(([rel]) => rel));
    for (const change of plan.changes) {
      if (change.kind === "archive") expectedFiles.delete(change.path);
      else {
        if (change.kind === "rename") expectedFiles.delete(change.from);
        expectedFiles.set(change.path, digest(change.content));
        modified.add(change.path);
        for (let dir = path.posix.dirname(change.path); dir !== "."; dir = path.posix.dirname(dir)) expectedDirectories.add(dir);
      }
    }
    const actualFiles = Object.entries(final.entries).filter(([, entry]) => entry.kind === "file");
    if (actualFiles.length !== expectedFiles.size || actualFiles.some(([rel, entry]) => entry.hash !== expectedFiles.get(rel)
      || (!modified.has(rel) && !same(entry, entries[rel])))) refuse("Abschlussprüfung erkennt abweichende Vault-Dateien.");
    const directories = Object.entries(final.entries).filter(([, entry]) => entry.kind === "directory");
    if (directories.length !== expectedDirectories.size || directories.some(([rel]) => !expectedDirectories.has(rel))) refuse("Abschlussprüfung erkennt abweichende Verzeichnisse.");
    await record({ phase: "verified", changes: plan.changes.length });
  } finally { await journal.close(); }
}

export async function runMigration(argv) {
  const options = argumentsFor(argv);
  if (options.help) {
    console.log("node scripts/migrate-vault.mjs --vault /absolute/vault --semester Sem01 --calendar /absolute/calendar.ics [--dry-run]\nApply: zusätzlich --apply --backup /absolute/empty-private-backup (statt --dry-run).\nKalender: lokale ICS-Datei oder JSON mit StudyEvent[] bzw. {events: StudyEvent[]}.\nStandard: Dry-run ohne Schreibzugriffe. Obsidian und study-manager vor Apply schließen.\nBackup enthält original/, archive/, staged/, plan.json, snapshot.json und journal.jsonl.");
    return;
  }
  const vault = await noSymlinkPath(options.vault);
  if (inside(key(vault), key(process.cwd())) || inside(key(vault), key(homedir()))) {
    refuse("Vault muss ein spezifisches Verzeichnis sein, kein System-, Home- oder Arbeitsverzeichnis-Vorfahre.");
  }
  if (!(await lstat(vault)).isDirectory() || await realpath(vault) !== vault) refuse("Vault muss ein echtes Verzeichnis sein.");
  const calendar = await noSymlinkPath(options.calendar);
  const read = await inspectFile(calendar, true);
  let events;
  try {
    if (read.content.trimStart().startsWith("BEGIN:VCALENDAR")) events = parseIcs(read.content);
    else {
      const parsed = JSON.parse(read.content);
      events = Array.isArray(parsed) ? parsed : parsed.events;
    }
  } catch { refuse("Kalenderdatei konnte nicht gelesen werden; Inhalt wird nicht protokolliert."); }
  if (!Array.isArray(events) || events.some((event) => !event || typeof event !== "object")) refuse("Kalender benötigt eine Liste von StudyEvents.");
  const original = await snapshot(vault, options.semester);
  const plan = planVaultMigration({ files: original.texts, events, semester: options.semester });
  validateTargets(plan, original.entries);
  await assertSnapshot(vault, options.semester, original.entries);
  await assertFile(path.dirname(calendar), path.basename(calendar), read.record);
  if (!options.apply || !plan.changes.length) {
    console.log(JSON.stringify({ mode: "dry-run", changes: plan.changes.length, ...plan.summary }, null, 2));
    return;
  }
  await appsClosed();
  const backup = await backupDirectory(options.backup, vault);
  if (inside(backup, calendar)) refuse("Kalender darf nicht im Backup-Ziel liegen.");
  await backupOriginal(vault, backup, original.entries);
  await stagePlan(backup, plan, original.entries, read.record);
  await assertSnapshot(vault, options.semester, original.entries);
  await assertFile(path.dirname(calendar), path.basename(calendar), read.record);
  await appsClosed();
  try { await commitPlan(vault, backup, plan, original.entries); }
  catch { refuse("Commit angehalten. Vault kann teilweise migriert sein; Original, Plan und Journal im Backup für Wiederherstellung verwenden. Keine automatische Rücksetzung."); }
  console.log(JSON.stringify({ mode: "applied", verified: true, changes: plan.changes.length, ...plan.summary }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runMigration(process.argv.slice(2)).catch((error) => {
    const safe = error instanceof Error && /^(?:Migration abgebrochen:|Vault-Migration:)/.test(error.message);
    console.error(safe ? error.message : "Migration abgebrochen: Validierung oder Dateisystemzugriff fehlgeschlagen; keine Dateiinhalte werden protokolliert.");
    process.exitCode = 1;
  });
}
