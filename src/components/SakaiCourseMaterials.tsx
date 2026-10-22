import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { join } from "@tauri-apps/api/path";
import type { useSakai } from "../hooks/useSakai";
import { resolveKnowledgeLink, type KnowledgeNote } from "../lib/knowledge";
import { apiOpenExternalUrl } from "../lib/storage";
import type { AppConfig } from "../lib/types";
import { MdPreview } from "./MdPreview";
import { IconChevron, IconDoc, IconOpen, IconSync } from "./icons";

interface Props {
  note?: KnowledgeNote;
  notes: KnowledgeNote[];
  subjectKey: string;
  cfg?: AppConfig;
  sakai?: Pick<ReturnType<typeof useSakai>, "connected" | "busy" | "progress" | "error" | "report" | "preferences" | "run" | "beginLogin">;
  onOpen: (path: string) => void;
}

function importedSections(body: string): Map<string, string> {
  const imported = body.split(/^<!-- sm:sakai:/m, 1)[0];
  const headings = [...imported.matchAll(/^## (.+)\r?$/gm)];
  return new Map(headings.map((heading, index) => [heading[1].trim(),
    imported.slice(heading.index + heading[0].length, headings[index + 1]?.index ?? imported.length).trim()]));
}

export function SakaiCourseMaterials({ note, notes, subjectKey, cfg, sakai, onOpen }: Props) {
  const [error, setError] = useState<string | null>(null);
  const sections = importedSections(note?.body ?? "");
  const resources = sections.get("Ressourcen");
  const overview = sections.get("Quellenübersicht");
  const lessons = sections.get("Lerninhalte aus Sakai");
  const announcements = sections.get("Ankündigungen der letzten 365 Tage");
  const selected = sakai?.preferences.selections.some((selection) => selection.subjectKey === subjectKey);
  const subjectFailed = sakai?.report?.failedSubjectKeys?.includes(subjectKey);
  const handleOpenLocal = async (target: string) => {
    setError(null);
    try {
      if (!note) return;
      const link = resolveKnowledgeLink(target, note.path);
      if (notes.some((entry) => entry.path === link.path)) onOpen(link.path + (link.heading ? `#${link.heading}` : ""));
      else {
        if (!cfg) throw new Error("Missing vault configuration");
        await invoke("open_knowledge_file", { path: await join(cfg.basisPfad, link.path) });
      }
    } catch { setError("Verknüpfte Datei konnte nicht geöffnet werden. Bitte Pfad und Datei im Vault prüfen."); }
  };
  const handleOpenLink = async (url: string) => {
    setError(null);
    if (!/^https?:\/\//i.test(url)) { await handleOpenLocal(url); return; }
    try { await apiOpenExternalUrl(url); }
    catch { setError("Weblink konnte nicht geöffnet werden."); }
  };
  const preview = (text: string) => <MdPreview text={text} onOpenFile={(path) => void handleOpenLocal(path)}
    onOpenWiki={(path) => void handleOpenLocal(path)} onOpenLink={(url) => void handleOpenLink(url)} />;
  return (
    <div className="sakai-course-materials">
      <div className="sakai-course-toolbar">
        <h4>Sakai-Unterlagen</h4>
        {sakai && <div className="knowledge-actions">
          <button type="button" className="knowledge-link" disabled={sakai.busy || !sakai.connected || !selected} onClick={() => void sakai.run(subjectKey)}><IconSync size={14} /> Sakai aktualisieren</button>
          {!sakai.connected && <button type="button" className="knowledge-link" disabled={sakai.busy} onClick={() => void sakai.beginLogin()}><IconOpen size={14} /> Bei Sakai anmelden</button>}
        </div>}
      </div>
      {sakai?.busy && <p className="prep-hint" role="status">{sakai.progress || "Sakai wird aktualisiert …"}</p>}
      {sakai && !sakai.connected && <p className="prep-hint">Sakai ist nicht verbunden. Gespeicherte Unterlagen bleiben verfügbar.</p>}
      {sakai?.connected && !selected && <p className="banner-info">Für dieses Fach ist noch kein Sakai-Kurs zugeordnet. Die Zuordnung findest du unter „Sakai & Studienwissen“.</p>}
      {sakai?.error && <p className="banner-error" role="alert">{sakai.error}</p>}
      {subjectFailed && <p className="banner-error" role="alert">Aktualisierung für dieses Fach fehlgeschlagen. {note ? "Angezeigt wird der letzte gespeicherte Stand." : "Es liegt noch kein gespeicherter Stand vor."}</p>}
      {!!sakai?.report?.warnings.length && <details className="banner-info" open={subjectFailed}><summary>Hinweise zum letzten Sakai-Abruf ({sakai.report.warnings.length})</summary><ul>{sakai.report.warnings.map((warning, index) => <li key={`${index}:${warning}`}>{warning}</li>)}</ul></details>}
      {note ? <>
        <button type="button" className="subject-knowledge-card sakai-course-note" onClick={() => onOpen(note.path)}>
          <span className="subject-knowledge-icon"><IconDoc size={20} /></span>
          <span className="subject-knowledge-copy">
            <small className="subject-knowledge-kind">Sakai Live</small>
            <strong>{note.title}</strong>
            <span>{note.retrievedAt ? `Zuletzt abgerufen am ${new Date(`${note.retrievedAt}T12:00:00Z`).toLocaleDateString("de-AT")}` : "Abrufdatum unbekannt"} · Gesamte Notiz öffnen</span>
          </span>
          <IconChevron size={15} />
        </button>
        <p className="prep-hint">{note.sourceStatus ? `Quellenstand: ${note.sourceStatus}. ` : ""}Die Geltung für den aktuellen Jahrgang ist nicht bestätigt.</p>
        {note.applicability && <p className="prep-hint">Geltung: {note.applicability}</p>}
        {error && <p className="banner-error" role="alert">{error}</p>}
        <div className="sakai-course-resources">
          <h4>Dateien & Präsentationen</h4>
          {resources ? preview(resources) : <p className="prep-hint">Im lokalen Abruf sind keine Ressourcen aufgeführt. Die gesamte Sakai-Notiz enthält weitere Kursinhalte.</p>}
        </div>
        {overview && <details className="sakai-course-details"><summary>Einführung & Kursinformationen</summary>{preview(overview)}</details>}
        {lessons && <details className="sakai-course-details"><summary>Lerninhalte aus Sakai</summary>{preview(lessons)}</details>}
        {announcements && <details className="sakai-course-details"><summary>Ankündigungen der letzten 365 Tage</summary>{preview(announcements)}</details>}
      </> : <p className="prep-hint">Für dieses Fach liegt noch kein Sakai-Abruf vor.</p>}
    </div>
  );
}
