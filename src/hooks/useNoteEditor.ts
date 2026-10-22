import { useEffect, useMemo, useSyncExternalStore } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { confirm } from "@tauri-apps/plugin-dialog";
import { createNoteEditor } from "../lib/drafts";
import { ensureTermin, isConflictError, readEditorNote, saveTerminNote } from "../lib/storage";
import { DEFAULT_CONFIG } from "../lib/types";
import type { AppConfig, StudyEvent } from "../lib/types";

export function useNoteEditor(cfg: AppConfig, event: StudyEvent, onPendingChange?: (pending: boolean) => void) {
  const { basisPfad, semester } = cfg;
  const { uid, terminRel } = event;
  const target = useMemo(() => ({ ...DEFAULT_CONFIG, basisPfad, semester }), [basisPfad, semester]);
  const editor = useMemo(() => createNoteEditor({ basisPfad: target.basisPfad, semester: target.semester, uid, terminRel }, {
    storage: () => localStorage,
    read: () => readEditorNote(target, { uid, terminRel }),
    write: (data, body, expected) => saveTerminNote(target, terminRel, data, body, expected),
    isConflictError,
  }), [target, uid, terminRel]);
  const state = useSyncExternalStore(editor.subscribe, editor.getSnapshot);

  useEffect(() => {
    void editor.start();
    const timer = window.setInterval(() => { void editor.refresh(); }, 3000);
    const handleFocus = () => { void editor.refresh(); };
    const handleUnload = (ev: BeforeUnloadEvent) => {
      if (!editor.getSnapshot().pending) return;
      ev.preventDefault();
      ev.returnValue = "";
    };
    const handleSave = (ev: KeyboardEvent) => {
      if (!(ev.metaKey || ev.ctrlKey) || ev.key.toLowerCase() !== "s") return;
      ev.preventDefault();
      void editor.save();
    };
    window.addEventListener("focus", handleFocus);
    window.addEventListener("beforeunload", handleUnload);
    window.addEventListener("keydown", handleSave);
    return () => {
      editor.stop();
      window.clearInterval(timer);
      window.removeEventListener("focus", handleFocus);
      window.removeEventListener("beforeunload", handleUnload);
      window.removeEventListener("keydown", handleSave);
    };
  }, [editor]);

  useEffect(() => {
    const notify = () => onPendingChange?.(editor.getSnapshot().pending);
    notify();
    const unsubscribe = editor.subscribe(notify);
    return () => { unsubscribe(); onPendingChange?.(false); };
  }, [editor, onPendingChange]);

  useEffect(() => {
    if (!isTauri()) return;
    let alive = true;
    let unlisten: (() => void) | undefined;
    let asking = false;
    void getCurrentWindow().onCloseRequested(async (ev) => {
      if (!alive) { ev.preventDefault(); return; }
      const snapshot = editor.getSnapshot();
      if (!snapshot.pending) return;
      ev.preventDefault();
      if (asking) return;
      asking = true;
      try {
        const discard = await confirm("Deine letzten Änderungen sind nur im Arbeitsspeicher. Trotzdem schließen und diese Änderungen verlieren?", {
          title: "Ungesicherte Notizen", kind: "warning", okLabel: "Änderungen verlieren", cancelLabel: "Zurück zur Notiz",
        });
        const latest = editor.getSnapshot();
        if (alive && discard && latest.body === snapshot.body && latest.data === snapshot.data) await getCurrentWindow().destroy();
      } catch (error) {
        window.alert(`Schließen abgebrochen: ${String(error)}`);
      } finally {
        asking = false;
      }
    }).then((cleanup) => {
      if (alive) unlisten = cleanup;
      else cleanup();
    }).catch((error: unknown) => {
      if (alive) window.alert(`Schutz beim Schließen konnte nicht eingerichtet werden: ${String(error)}`);
    });
    return () => { alive = false; unlisten?.(); };
  }, [editor]);

  return { ...state, editor, create: () => editor.create(async () => (await ensureTermin(target, event)).raw) };
}
