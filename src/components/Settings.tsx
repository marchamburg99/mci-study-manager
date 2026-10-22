import { useEffect, useRef, useState } from "react";
import type { AppConfig } from "../lib/types";
import { apiChooseVaultRoot } from "../lib/storage";
import { errorMessage, validateConfig } from "../lib/config";

export function Settings({ cfg, disabled, onSave, onClose, onOpenSetup }: {
  cfg: AppConfig;
  disabled: boolean;
  onSave: (cfg: AppConfig) => Promise<void>;
  onClose: () => void;
  onOpenSetup: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [draft, setDraft] = useState(cfg);
  const [saving, setSaving] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = saving || choosing;

  useEffect(() => {
    const node = dialog.current;
    node?.showModal();
    return () => node?.close();
  }, []);

  const choose = async () => {
    setChoosing(true);
    try {
      const path = await apiChooseVaultRoot();
      if (path) setDraft((previous) => ({ ...previous, basisPfad: path }));
      setError(null);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setChoosing(false);
    }
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await onSave(validateConfig(draft));
      onClose();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <dialog ref={dialog} className="modal" aria-labelledby="settings-title" onCancel={(event) => {
      event.preventDefault();
      if (!busy) onClose();
    }}>
      <form onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <div className="modal-head">
          <div>
            <h2 id="settings-title">Einstellungen</h2>
            <p>Vault und Stundenplan für dein Studium.</p>
          </div>
          <button type="button" className="iconbtn" onClick={onClose} disabled={busy} aria-label="Einstellungen schließen">×</button>
        </div>
        {error && <p role="alert" className="banner-error">{error}</p>}
        <fieldset disabled={busy || disabled} className="settings-fields">
          <label className="field">
            <span>Vault-Pfad</span>
            <input value={draft.basisPfad} readOnly />
            <small>Wähle einen eigenen Studienordner, nicht deinen gesamten Benutzerordner.</small>
          </label>
          <button type="button" className="ghostbtn" onClick={() => void choose()}>Ordner auswählen …</button>
          <label className="field">
            <span>Semester-Ordner</span>
            <input value={draft.semester} required maxLength={128} onChange={(event) => setDraft({ ...draft, semester: event.target.value })} />
          </label>
          <label className="field">
            <span>iCal-URL</span>
            <input value={draft.icalUrl} type="password" autoComplete="off" spellCheck={false} required onChange={(event) => setDraft({ ...draft, icalUrl: event.target.value })} />
            <small>Dein persönlicher Kalender-Abo-Link deines MCI-Stundenplans (HTTPS oder Webcal). Er enthält einen privaten Zugriffsschlüssel, also nicht weitergeben.</small>
          </label>
          <label className="field field-short">
            <span>Automatisch synchronisieren</span>
            <span className="field-inline">
              <input type="number" min={1} max={168} step={1} required value={draft.refreshHours} onChange={(event) => setDraft({ ...draft, refreshHours: Number(event.target.value) })} />
              <span>Stunden</span>
            </span>
            <small>Während die Desktop-App geöffnet ist, auch nach dem Aufwachen.</small>
          </label>
          <button type="submit" className="primary">{saving ? "Speichert …" : "Speichern & synchronisieren"}</button>
        </fieldset>
        <div className="modal-actions">
          <button type="button" className="ghostbtn" onClick={onOpenSetup} disabled={busy}>Einführung öffnen</button>
          <button type="button" className="ghostbtn" onClick={onClose} disabled={busy}>Abbrechen</button>
        </div>
      </form>
    </dialog>
  );
}
