import { useEffect, useRef, useState } from "react";
import type { AppConfig } from "../lib/types";
import { apiChooseVaultRoot, apiObsidianInstalled, apiOpenExternalUrl, apiOpenObsidian, apiRevealVaultPath } from "../lib/storage";
import { errorMessage, normalizeCalendarUrl, validateConfig } from "../lib/config";

const STEPS = ["Willkommen", "Obsidian", "Studienordner", "Stundenplan", "Sakai", "Einrichten"] as const;
const OBSIDIAN_DOWNLOAD = "https://obsidian.md/download";

const AI_PROMPT = `Du arbeitest in meinem Studienordner (Obsidian-Vault des MCI Studien-Managers).
Lies zuerst AGENTS.md im Ordner; dort stehen Struktur und Regeln.
Ändere keine automatisch erzeugten Bereiche (Marker sm:list und sm:sakai) und nichts unter .mci-manager/.
Aufgabe: `;

type ObsidianState = "checking" | "installed" | "missing" | "unknown";

async function probeObsidian(): Promise<ObsidianState> {
  try {
    return await apiObsidianInstalled() ? "installed" : "missing";
  } catch {
    return "unknown";
  }
}

export function SetupWizard({ cfg, disabled, onSave, onClose }: {
  cfg: AppConfig;
  disabled: boolean;
  /** Resolves to a sync error message when the config was saved but the first sync failed. */
  onSave: (cfg: AppConfig) => Promise<string | null>;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState(cfg);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [obsidian, setObsidian] = useState<ObsidianState>("checking");
  const last = step === STEPS.length - 1;

  useEffect(() => {
    const node = dialog.current;
    node?.showModal();
    return () => node?.close();
  }, []);

  useEffect(() => {
    let active = true;
    void probeObsidian().then((state) => {
      if (active) setObsidian(state);
    });
    return () => { active = false; };
  }, []);

  const handleCheckObsidian = async () => {
    setObsidian("checking");
    setObsidian(await probeObsidian());
  };

  const run = async (action: () => Promise<void>) => {
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };

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
      if (step === 2 && !draft.basisPfad.trim()) throw new Error("Bitte einen Studienordner auswählen.");
      if (step === 3) normalizeCalendarUrl(draft.icalUrl);
      if (!last) {
        setStep(step + 1);
        return;
      }
      setBusy(true);
      const syncError = await onSave(validateConfig(draft));
      if (syncError) throw new Error(`Einstellungen gespeichert, aber die Einrichtung ist nicht fertig. ${syncError}`);
      setDone(true);
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

  const downloadButton = (
    <button type="button" className="ghostbtn" onClick={() => void run(() => apiOpenExternalUrl(OBSIDIAN_DOWNLOAD))}>
      Obsidian herunterladen
    </button>
  );

  if (done) {
    return (
      <dialog ref={dialog} className="modal setup" aria-labelledby="setup-title" onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}>
        <div className="modal-head">
          <div>
            <p className="setup-progress">Einrichtung abgeschlossen</p>
            <h2 id="setup-title">Dein Studienordner ist bereit</h2>
          </div>
          <button type="button" className="iconbtn" onClick={onClose} aria-label="Einrichtung schließen">×</button>
        </div>
        {error && <p role="alert" className="banner-error">{error}</p>}
        <div className="settings-fields setup-body">
          <p>Angelegt in <code>{draft.basisPfad}</code>: Semester- und Fachordner, das Dashboard <code>README.md</code>, Vorlagen und die KI-Anleitung <code>AGENTS.md</code>.</p>
          <h3>Obsidian verbinden</h3>
          {obsidian === "installed" ? (
            <>
              <ol>
                <li>Obsidian öffnen.</li>
                <li><strong>Ordner als Vault öffnen</strong> wählen und <code>{draft.basisPfad}</code> auswählen.</li>
                <li>Bei der Frage nach Vertrauen <strong>Vertrauen</strong> bestätigen. Danach öffnet Obsidian den Vault jedes Mal direkt.</li>
              </ol>
              <button type="button" className="ghostbtn" onClick={() => void run(apiOpenObsidian)}>Obsidian öffnen</button>
            </>
          ) : (
            <>
              <p>Obsidian ist noch nicht installiert. Nach der Installation den Ordner <code>{draft.basisPfad}</code> mit <strong>Ordner als Vault öffnen</strong> wählen.</p>
              {downloadButton}
            </>
          )}
          <button type="button" className="ghostbtn" onClick={() => void run(() => apiRevealVaultPath(draft.basisPfad))}>Im Finder zeigen</button>
          <h3>KI-Assistenten</h3>
          <p>Claude Code, Codex und Cursor lesen <code>AGENTS.md</code> automatisch, wenn du den Studienordner als Arbeitsordner öffnest. Für ChatGPT oder Gemini im Browser lädst du Notizen hoch und beginnst mit diesem Einstieg:</p>
          <pre className="setup-prompt">{AI_PROMPT}</pre>
          <button type="button" className="ghostbtn" onClick={() => void handleCopyPrompt()}>{copied ? "Kopiert" : "Einstieg kopieren"}</button>
          <h3>Nächster Schritt: Sakai</h3>
          <p>Links <strong>Studienwissen</strong> öffnen und <strong>Bei Sakai anmelden</strong> wählen.</p>
        </div>
        <div className="modal-actions">
          <button type="button" className="primary" onClick={onClose} autoFocus>Los geht’s</button>
        </div>
      </dialog>
    );
  }

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
              <p>In den nächsten Schritten richtest du alles ein:</p>
              <ul>
                <li><strong>Obsidian</strong> zum Lesen und Schreiben deiner Notizen.</li>
                <li><strong>Studienordner</strong> mit Fächern, Terminen, Vorlagen und KI-Anleitung.</li>
                <li><strong>Stundenplan</strong> aus deinem persönlichen MCI-Kalender.</li>
                <li><strong>Sakai</strong> für Folien und Ankündigungen, optional.</li>
              </ul>
              <p>Alles bleibt lokal auf deinem Mac. Die Einrichtung dauert etwa drei Minuten.</p>
            </>
          )}
          {step === 1 && (
            <>
              <p>Obsidian ist ein kostenloses Notizprogramm. Es öffnet deinen Studienordner direkt, mit Verlinkungen, Suche und dem Dashboard für Vor- und Nachbereitung.</p>
              <p role="status">
                {obsidian === "checking" && "Prüfe, ob Obsidian installiert ist …"}
                {obsidian === "installed" && "✓ Obsidian ist installiert."}
                {obsidian === "missing" && "Obsidian ist noch nicht installiert."}
                {obsidian === "unknown" && "Ob Obsidian installiert ist, ließ sich nicht prüfen."}
              </p>
              {obsidian !== "installed" && (
                <>
                  <ol>
                    <li>Auf der Download-Seite die Version für macOS laden.</li>
                    <li>Die DMG öffnen und Obsidian in den Programme-Ordner ziehen.</li>
                    <li>Hier <strong>Erneut prüfen</strong> wählen.</li>
                  </ol>
                  {downloadButton}
                  <button type="button" className="ghostbtn" onClick={() => void handleCheckObsidian()}>Erneut prüfen</button>
                </>
              )}
              <small className="setup-note">Ohne Obsidian funktioniert die App auch; die Notizen bleiben normale Markdown-Dateien.</small>
            </>
          )}
          {step === 2 && (
            <>
              <p>Der Studienordner wird dein Obsidian-Vault. Der Vorschlag <code>~/MCI</code> passt für die meisten; ein bestehender Vault funktioniert ebenfalls. Vorhandene Dateien werden nie überschrieben.</p>
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
          {step === 3 && (
            <>
              <p>Die App liest deinen persönlichen Stundenplan als Kalender-Abo. Den Link findest du in deinem MCI-Stundenplan unter der Kalender-Abo- bzw. iCal-Funktion.</p>
              <label className="field">
                <span>Kalender-Link</span>
                <input value={draft.icalUrl} type="password" autoComplete="off" spellCheck={false} required placeholder="https://… oder webcal://…" onChange={(event) => setDraft({ ...draft, icalUrl: event.target.value })} />
                <small>Der Link enthält einen privaten Schlüssel. Nicht weitergeben und nicht in Gruppenchats posten.</small>
              </label>
            </>
          )}
          {step === 4 && (
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
          {step === 5 && (
            <>
              <p>Beim Einrichten legt die App deinen Studienordner an und lädt den Stundenplan:</p>
              <ul>
                <li><strong>Ordner:</strong> <code>{draft.basisPfad}</code>, Semester <code>{draft.semester}</code></li>
                <li><strong>Inhalt:</strong> Semester- und Fachordner, Dashboard, Vorlagen, KI-Anleitung (<code>AGENTS.md</code>)</li>
                <li><strong>Obsidian:</strong> {obsidian === "installed" ? "installiert" : "noch nicht installiert, geht auch später"}</li>
              </ul>
              <p>Das dauert je nach Verbindung einige Sekunden.</p>
            </>
          )}
        </fieldset>
        <div className="modal-actions">
          {step > 0 && <button type="button" className="ghostbtn" onClick={() => { setError(null); setStep(step - 1); }} disabled={busy}>Zurück</button>}
          <button type="submit" className="primary" disabled={busy || disabled}>
            {last ? (busy ? "Richtet ein …" : "Einrichten & synchronisieren") : "Weiter"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
