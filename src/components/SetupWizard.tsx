import { useEffect, useRef, useState } from "react";
import type { AppConfig } from "../lib/types";
import { apiChooseVaultRoot } from "../lib/storage";
import { errorMessage, normalizeCalendarUrl, validateConfig } from "../lib/config";

const STEPS = ["Willkommen", "Studienordner", "Stundenplan", "Sakai", "KI-Assistenten"] as const;

const AI_PROMPT = `Du arbeitest in meinem Studienordner (Markdown-Vault des MCI Studien-Managers).
Jedes Fach hat einen Ordner mit Terminordnern (YYYY-MM-DD_...) für Notizen und docs/ für Folien.
Unter Studium/ liegen die Sakai-Live-Notizen, Original-PDFs unter Studium/Quellen/.
Ändere keine automatisch erzeugten Sakai-Bereiche (Marker sm:sakai); eigene Ergänzungen
gehören unter "Persönliche Notizen" oder in neue Dateien.
Aufgabe: `;

export function SetupWizard({ cfg, disabled, onSave, onClose }: {
  cfg: AppConfig;
  disabled: boolean;
  onSave: (cfg: AppConfig) => Promise<void>;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState(cfg);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const last = step === STEPS.length - 1;

  useEffect(() => {
    const node = dialog.current;
    node?.showModal();
    return () => node?.close();
  }, []);

  const choose = async () => {
    setBusy(true);
    try {
      const path = await apiChooseVaultRoot();
      if (path) setDraft((previous) => ({ ...previous, basisPfad: path }));
      setError(null);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  const handleNext = async () => {
    setError(null);
    try {
      if (step === 1 && !draft.basisPfad.trim()) throw new Error("Bitte einen Studienordner auswählen.");
      if (step === 2) normalizeCalendarUrl(draft.icalUrl);
      if (!last) {
        setStep(step + 1);
        return;
      }
      setBusy(true);
      await onSave(validateConfig(draft));
      onClose();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  const handleCopyPrompt = async () => {
    try {
      await navigator.clipboard.writeText(AI_PROMPT);
      setCopied(true);
    } catch {
      setError("Kopieren nicht möglich. Bitte den Text markieren und manuell kopieren.");
    }
  };

  return (
    <dialog ref={dialog} className="modal setup" aria-labelledby="setup-title" onCancel={(event) => {
      event.preventDefault();
      if (!busy) onClose();
    }}>
      <form onSubmit={(event) => { event.preventDefault(); void handleNext(); }}>
        <div className="modal-head">
          <div>
            <p className="setup-progress">Schritt {step + 1} von {STEPS.length}</p>
            <h2 id="setup-title">{STEPS[step]}</h2>
          </div>
          <button type="button" className="iconbtn" onClick={onClose} disabled={busy} aria-label="Einrichtung schließen">×</button>
        </div>
        <ol className="setup-dots" aria-hidden="true">
          {STEPS.map((name, index) => <li key={name} className={index <= step ? "on" : undefined} />)}
        </ol>
        {error && <p role="alert" className="banner-error">{error}</p>}
        <fieldset disabled={busy || disabled} className="settings-fields setup-body">
          {step === 0 && (
            <>
              <p>Der Studien-Manager zeigt dir, welche Lehrveranstaltung gerade ansteht, und öffnet das passende Fach mit Notizen, Folien und Sakai-Unterlagen.</p>
              <ul>
                <li><strong>Heute & Kalender:</strong> dein Stundenplan, automatisch aktualisiert.</li>
                <li><strong>Fächer:</strong> pro Einheit ein Ordner für Markdown-Notizen und Dokumente per Drag&Drop.</li>
                <li><strong>Studienwissen:</strong> Sakai-Inhalte und eigene Zusammenfassungen, durchsuchbar.</li>
              </ul>
              <p>Alles bleibt lokal auf deinem Mac. Die Einrichtung dauert etwa zwei Minuten.</p>
            </>
          )}
          {step === 1 && (
            <>
              <p>Wähle einen eigenen Ordner für dein Studium, zum Beispiel <code>~/MCI</code>. Wenn du Obsidian nutzt, kann das dein Vault sein.</p>
              <label className="field">
                <span>Studienordner</span>
                <input value={draft.basisPfad} readOnly placeholder="Noch kein Ordner gewählt" />
              </label>
              <button type="button" className="ghostbtn" onClick={() => void choose()}>Ordner auswählen …</button>
              <label className="field">
                <span>Semester-Ordner</span>
                <input value={draft.semester} required maxLength={128} onChange={(event) => setDraft({ ...draft, semester: event.target.value })} />
                <small>Unterordner für dieses Semester. Der Vorschlag passt für MCiT 26, Semester 1.</small>
              </label>
            </>
          )}
          {step === 2 && (
            <>
              <p>Die App liest deinen persönlichen Stundenplan als Kalender-Abo. Den Link findest du in deinem MCI-Stundenplan unter der Kalender-Abo- bzw. iCal-Funktion.</p>
              <label className="field">
                <span>Kalender-Link</span>
                <input value={draft.icalUrl} type="password" autoComplete="off" spellCheck={false} required placeholder="https://… oder webcal://…" onChange={(event) => setDraft({ ...draft, icalUrl: event.target.value })} />
                <small>Der Link enthält einen privaten Schlüssel. Nicht weitergeben und nicht in Gruppenchats posten.</small>
              </label>
            </>
          )}
          {step === 3 && (
            <>
              <p>Sakai-Unterlagen holst du nach der Einrichtung so in die App:</p>
              <ol>
                <li>Links <strong>Studienwissen</strong> öffnen und <strong>Bei Sakai anmelden</strong> wählen.</li>
                <li>Im Sakai-Fenster normal anmelden.</li>
                <li>Optional <strong>Automatisch anmelden</strong> aktivieren: Sakai beendet Sitzungen nach einer Stunde ohne Aktivität, die App meldet sich dann selbst wieder an. Das Passwort liegt dafür im macOS-Schlüsselbund.</li>
                <li>Kurse den Fächern zuordnen und <strong>Jetzt abrufen</strong> wählen. Mit der Automatik bleibt alles aktuell.</li>
              </ol>
              <p>Dieser Schritt ist optional. Kalender und Notizen funktionieren auch ohne Sakai.</p>
            </>
          )}
          {step === 4 && (
            <>
              <p>Dein Studienordner besteht aus normalen Markdown-Dateien und PDFs. Jede KI, die lokale Ordner lesen kann, kann damit arbeiten:</p>
              <ul>
                <li><strong>Claude Cowork oder Claude Code:</strong> den Studienordner als Arbeitsordner freigeben und unten stehenden Einstieg verwenden.</li>
                <li><strong>Obsidian mit KI-Plugin:</strong> den Studienordner als Vault öffnen.</li>
                <li><strong>ChatGPT, Gemini & Co.:</strong> einzelne Notizen oder PDFs aus dem Ordner hochladen.</li>
              </ul>
              <p>Gute Aufgaben: Zusammenfassung einer Einheit, Lernkarten aus den Folien, Prüfungsfragen zu einem Fach, offene Punkte aus den Ankündigungen.</p>
              <pre className="setup-prompt">{AI_PROMPT}</pre>
              <button type="button" className="ghostbtn" onClick={() => void handleCopyPrompt()}>{copied ? "Kopiert" : "Einstieg kopieren"}</button>
              <small className="setup-note">Lass KI-Ergebnisse als eigene Dateien speichern und prüfe sie mit den Originalunterlagen.</small>
            </>
          )}
        </fieldset>
        <div className="modal-actions">
          {step > 0 && <button type="button" className="ghostbtn" onClick={() => { setError(null); setStep(step - 1); }} disabled={busy}>Zurück</button>}
          <button type="submit" className="primary" disabled={busy || disabled}>
            {last ? (busy ? "Speichert …" : "Fertig & synchronisieren") : "Weiter"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
