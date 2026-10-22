import { useMemo, useState } from "react";
import type { StudyEvent } from "../lib/types";
import { buildFaecher } from "../lib/ical";
import type { useSakai } from "../hooks/useSakai";
import { IconOpen, IconSync } from "./icons";

interface Props {
  sync: ReturnType<typeof useSakai>;
  events: StudyEvent[];
}

export function SakaiPanel({ sync, events }: Props) {
  const [expanded, setExpanded] = useState(false);
  const subjects = useMemo(() => buildFaecher(events), [events]);
  const selected = new Map(sync.preferences.selections.map((entry) => [entry.siteId, entry.subjectKey]));
  const missing = sync.preferences.selections.filter((entry) => !sync.sites.some((site) => site.id === entry.siteId));
  const choose = (siteId: string, subjectKey: string | null, checked: boolean) => {
    sync.setSelections([...sync.preferences.selections.filter((entry) => entry.siteId !== siteId), ...(checked ? [{ siteId, subjectKey }] : [])]);
  };
  return (
    <section className="sakai-panel" aria-label="Direkter Sakai-Sync">
      <div className="knowledge-heading">
        <div><h2>Sakai-Sync</h2><p className="prep-hint">{sync.connected ? (sync.rememberSession ? "Verbunden · Angemeldet bleiben ist aktiviert" : "Verbunden für diese App-Sitzung") : "Offline-Wissen bleibt verfügbar. Für neue Inhalte bitte in Sakai anmelden."}</p></div>
        <div className="knowledge-actions">
          {!sync.connected && <button className="knowledge-link" disabled={sync.busy} onClick={() => void sync.beginLogin()}><IconOpen size={14} /> {sync.loginOpen ? "Anmeldefenster zeigen" : "Bei Sakai anmelden"}</button>}
          {sync.loginOpen && sync.loginCheckFailed && <button className="sakai-primary" disabled={sync.busy} onClick={() => void sync.connect()}>Anmeldung erneut prüfen</button>}
          {!sync.connected && !sync.loginOpen && sync.error && <button className="knowledge-link" disabled={sync.busy} onClick={() => void sync.connect()}>Verbindung erneut prüfen</button>}
          {sync.connected && sync.sites.length === 0 && <button className="sakai-primary" disabled={sync.busy} onClick={() => void sync.connect()}>Kursliste laden</button>}
          {sync.connected && sync.sites.length > 0 && <button className="sakai-primary" disabled={sync.busy || selected.size === 0} onClick={() => void sync.run()}><IconSync size={14} /> Jetzt abrufen</button>}
          {(sync.connected || sync.loginOpen || sync.busy || sync.rememberSession || sync.persistenceError) && <button className="knowledge-link" onClick={() => void sync.disconnect()}>{sync.busy ? "Abruf abbrechen" : "Verbindung trennen"}</button>}
        </div>
      </div>
      <label className="prep-hint"><input type="checkbox" checked={sync.rememberSession} disabled={sync.busy || sync.loginOpen} onChange={(event) => void sync.setRememberSession(event.target.checked)} /> Auf diesem Mac angemeldet bleiben</label>
      {sync.loginOpen && <p className="banner-info">Melde dich im separaten Sakai-Fenster an. Die App erkennt die Anmeldung automatisch und schließt das Fenster. Apple AutoFill ist im Kontextmenü der Eingabefelder verfügbar.</p>}
      {sync.persistenceError && <p className="banner-error" role="alert">Die Sakai-Sitzung konnte nicht zuverlässig im Schlüsselbund gespeichert, gelesen oder gelöscht werden. Bitte den macOS-Schlüsselbund-Zugriff prüfen. „Verbindung trennen“ versucht erneut, die gespeicherte Sitzung zu entfernen.</p>}
      <p className="prep-hint">Nur lesender Abruf von Kursübersichten, Lerninhalten, Ankündigungen der letzten 365 Tage und Ressourcen. Keine Nachrichten, Noten oder Abgaben. PDFs bis 15 MiB werden lokal gespeichert, andere Formate bleiben verlinkt. Keine automatische Auswertung des PDF-Inhalts.</p>
      {sync.connected && <>
        <div className="sakai-options">
          {!sync.hasPreferences && <button className="knowledge-link" disabled={sync.busy} onClick={() => void sync.connect()}>Bekannte Quellen vorschlagen</button>}
          <label><input type="checkbox" checked={sync.preferences.autoSync} disabled={sync.busy} onChange={(event) => sync.setAutoSync(event.target.checked)} /> Automatisch beim Öffnen und alle 5 Minuten aktualisieren</label>
          <button className="knowledge-link" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{selected.size} Sites ausgewählt · Auswahl {expanded ? "schließen" : "prüfen"}</button>
        </div>
        {expanded && <div className="sakai-sites">
          <button className="knowledge-link" disabled={sync.busy} onClick={() => void sync.connect()}>Kursliste aktualisieren</button>
          <p className="prep-hint">Bekannte Quellen werden vorgeschlagen. UE und VO können demselben Fach zugeordnet werden. „Studium“ behält übergreifendes Wissen getrennt.</p>
          {sync.sites.map((site) => <div className="sakai-site" key={site.id}>
            <label><input type="checkbox" checked={selected.has(site.id)} disabled={sync.busy} onChange={(event) => choose(site.id, selected.get(site.id) ?? null, event.target.checked)} /><span>{site.title}</span></label>
            <select aria-label={`Zuordnung für ${site.title}`} disabled={sync.busy || !selected.has(site.id)} value={selected.get(site.id) ?? ""} onChange={(event) => choose(site.id, event.target.value || null, true)}>
              <option value="">Studium</option>
              {subjects.map((subject) => <option key={subject.key} value={subject.key}>{subject.name}</option>)}
            </select>
          </div>)}
          {missing.length > 0 && <p className="banner-info">{missing.length} früher ausgewählte Sites sind aktuell nicht erreichbar. Ihre lokalen Notizen bleiben erhalten. <button className="knowledge-link" disabled={sync.busy} onClick={() => sync.setSelections(sync.preferences.selections.filter((entry) => sync.sites.some((site) => site.id === entry.siteId)))}>Nicht erreichbare Sites abwählen</button></p>}
        </div>}
      </>}
      {sync.preferences.lastSync && <p className="prep-hint">Letzter Durchlauf: {new Date(sync.preferences.lastSync).toLocaleString("de-AT")}. Der Quellenstand steht zusätzlich in jeder Live-Notiz.</p>}
      {sync.progress && <p className="prep-hint" role="status">{sync.progress}</p>}
      {sync.report && <div role="status"><p>{sync.report.updated} Live-Notizen aktualisiert · {sync.report.unchanged} unverändert · {sync.report.downloaded} PDFs gespeichert</p>
        {sync.report.warnings.length > 0 && <details className="banner-info"><summary>{sync.report.warnings.length} {sync.report.warnings.length === 1 ? "Hinweis" : "Hinweise"} zum Abruf</summary><ul>{sync.report.warnings.map((warning, index) => <li key={`${index}:${warning}`}>{warning}</li>)}</ul></details>}
      </div>}
      {sync.error && <p className="banner-error" role="alert">{sync.error}</p>}
      <p className="prep-hint">Ohne „Angemeldet bleiben“ bleibt die Sitzung nur im Arbeitsspeicher. Mit der Option wird sie im macOS-Schlüsselbund gespeichert, nicht dein Passwort. Sakai kann eine erneute Anmeldung verlangen. „Verbindung trennen“ löscht die gespeicherte Sitzung. Eigene Zusammenfassungen und Terminnotizen bleiben unverändert.</p>
    </section>
  );
}
