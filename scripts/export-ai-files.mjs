import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Exports the vault files the app scaffolds, laid out as in a study vault, for people who
// want them without the app or for an existing Obsidian vault. Usage: export-ai-files.mjs <empty-dir>
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceDir = path.join(root, "src", "scaffold", "vault");

const README = `KI-Dateien für den Studienordner (MCI Studien-Manager {{VERSION}})

Die App legt diese Dateien beim Einrichten automatisch an. Dieser Download ist für alle,
die sie von Hand in einen bestehenden Obsidian-Vault oder Studienordner kopieren wollen.

So geht's:
1. Den gesamten Inhalt dieses Ordners in den Hauptordner deines Vaults kopieren.
   Dateien, die du dort schon hast, nicht ersetzen (im Finder "Überspringen" wählen).
2. Ordner mit Punkt am Anfang (.agents, .claude, .obsidian) blendet der Finder aus.
   Mit Cmd+Shift+Punkt werden sie sichtbar und lassen sich mitkopieren.

Was die Dateien tun:
- AGENTS.md: Einstieg für KI-Assistenten (Claude Code, Codex, Cursor). Erklärt Ordnerstruktur und Regeln.
- CLAUDE.md: lässt Claude Code dieselbe AGENTS.md lesen.
- .agents/study/: Regeln für Planung, Notizen und Lernen, Recherche und wissenschaftliches Arbeiten.
- .claude/settings.json: verbietet Claude Code, App-Daten, Obsidian-Einstellungen und Original-PDFs zu ändern.
- .obsidian/types.json: Eigenschaftstypen für termin, vorbereitet und nachbereitet.
- 00-system/templates/agent/: Vorlagen für Arbeitsauftrag, Studienplan, Recherche, Quellen, Lernprüfung, KI-Logbuch.
- 00-system/views/: Obsidian-Ansichten (Bases) für vorzubereitende Termine und offene Aufgaben.

Die Ordnernamen in AGENTS.md beschreiben die Struktur, die der Studien-Manager anlegt.
Ohne die App passt AGENTS.md an deine eigene Ordnerstruktur an.
`;

async function main() {
  const [target] = process.argv.slice(2);
  if (!target || !path.isAbsolute(target)) throw new Error("Usage: export-ai-files.mjs <absolute empty directory>");
  await mkdir(target, { recursive: true });
  if ((await readdir(target)).length) throw new Error("Target directory must be empty.");
  const manifest = JSON.parse(await readFile(path.join(sourceDir, "manifest.json"), "utf8"));
  for (const [vaultPath, source] of Object.entries(manifest)) {
    const destination = path.join(target, ...vaultPath.split("/"));
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(path.join(sourceDir, ...source.split("/")), destination);
  }
  const { version } = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  await writeFile(path.join(target, "LIESMICH.txt"), README.replace("{{VERSION}}", version));
  console.log(`Exported ${Object.keys(manifest).length} files to ${target}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
