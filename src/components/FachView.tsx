import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { join } from "@tauri-apps/api/path";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { AppConfig, StudyEvent } from "../lib/types";
import {
  apiCopyInto,
  apiDeleteFile,
  apiListDocs,
  apiOpenVaultFile,
  apiOpenExternalUrl,
  apiRevealVaultPath,
  apiPickDocuments,
  docsDir,
  terminDir,
} from "../lib/storage";
import type { DocEntry } from "../lib/storage";
import { embedMarkup, insertAtCursor, isSafeRelativePath, readStatus } from "../lib/notes";
import { formatTag, formatZeit } from "../lib/focus";
import type { KnowledgeNote } from "../lib/knowledge";
import { resolveKnowledgeTarget } from "../lib/knowledgeLinks";
import { useNoteEditor } from "../hooks/useNoteEditor";
import { MdPreview } from "./MdPreview";
import { FachKalender } from "./FachKalender";
import { QuizPractice } from "./QuizPractice";
import {
  IconBack,
  IconDoc,
  IconTrash,
  IconOpen,
  IconFolder,
  IconClock,
} from "./icons";

interface Props {
  cfg: AppConfig;
  event: StudyEvent;
  events: StudyEvent[];
  hue: number;
  knowledge?: ReactNode;
  knowledgeNotes: KnowledgeNote[];
  onBack: () => void;
  backLabel?: string;
  onOpen: (uid: string) => void;
  onOpenKnowledge: (path: string) => void;
  onOpenSubject: (key: string, name: string) => void;
  onPendingChange?: (pending: boolean) => void;
}

function CheckRow({
  label,
  sub,
  checked,
  disabled,
  onToggle,
}: {
  label: string;
  sub: string;
  checked: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      className={`checkrow ${checked ? "done" : ""}`}
      onClick={onToggle}
      disabled={disabled}
      role="checkbox"
      aria-checked={checked}
    >
      <span className="checkbox" aria-hidden="true">
        {checked && (
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4.5 12.5l5 5 10-11" />
          </svg>
        )}
      </span>
      <span className="checkrow-main">
        <strong>{label}</strong>
        <span>{sub}</span>
      </span>
    </button>
  );
}

export function FachView({ cfg, event, events, hue, knowledge, knowledgeNotes, onBack, backLabel = "Heute", onOpen, onOpenKnowledge, onOpenSubject, onPendingChange }: Props) {
  const { data, body: fullBody, head, prefix, loaded, dirty, saving, discarding, pending, conflict, readError, draftError, message, canCreate, editor, create } = useNoteEditor(cfg, event, onPendingChange);
  const body = fullBody.slice(prefix.length);
  const editable = loaded && !readError && !discarding;
  const [docs, setDocs] = useState<DocEntry[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [preview, setPreview] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const selRef = useRef({ s: 0, e: 0 });

  const status = readStatus(data, fullBody);
  const lifetime = useRef<object | null>(null);
  const reloadDocs = useCallback(() => {
    const current = lifetime.current;
    return docsDir(cfg, event.terminRel).then(apiListDocs).then((entries) => {
      if (current && lifetime.current === current) setDocs(entries);
    }).catch((error: unknown) => {
      if (current && lifetime.current === current) setMsg(`Dokumente konnten nicht geladen werden: ${String(error)}`);
    });
  }, [cfg, event.terminRel, setDocs, setMsg]);

  const importDocuments = useCallback(async (paths: string[]) => {
    const current = lifetime.current;
    const state = editor.getSnapshot();
    if (!current || !state.loaded || state.readError || state.discarding) return;
    try {
      const dir = await docsDir(cfg, event.terminRel);
      for (const src of paths) {
        if (lifetime.current !== current) return;
        try {
          const dest = await apiCopyInto(src, dir);
          if (lifetime.current !== current) return;
          const latest = editor.getSnapshot();
          if (latest.readError || latest.discarding) {
            setMsg("Datei abgelegt. Bitte nach dem Beheben des Notizfehlers manuell verknüpfen.");
            continue;
          }
          const rest = latest.body.slice(latest.prefix.length);
          const result = insertAtCursor(rest, selRef.current.s, selRef.current.s, `\n${embedMarkup(dest.split("/").pop() ?? "datei")}\n`);
          editor.edit(latest.prefix + result.text);
          selRef.current = { s: result.cursor, e: result.cursor };
          requestAnimationFrame(() => {
            if (lifetime.current !== current) return;
            taRef.current?.focus();
            taRef.current?.setSelectionRange(result.cursor, result.cursor);
          });
        } catch (error) {
          if (lifetime.current === current) setMsg(`Konnte nicht ablegen: ${String(error)}`);
        }
      }
      await reloadDocs();
    } catch (error) {
      if (lifetime.current === current) setMsg(`Import fehlgeschlagen: ${String(error)}`);
    }
  }, [cfg, event.terminRel, editor, reloadDocs, setMsg]);

  useEffect(() => {
    const current = {};
    lifetime.current = current;
    void reloadDocs();
    let unlisten: (() => void) | undefined;
    if (isTauri()) {
      void getCurrentWindow().onDragDropEvent(async (ev) => {
          if (lifetime.current !== current) return;
          if (ev.payload.type === "over") {
            setDragOver(true);
          } else if (ev.payload.type === "drop") {
            setDragOver(false);
            await importDocuments(ev.payload.paths);
          } else {
            setDragOver(false);
          }
        }).then((cleanup) => {
          if (lifetime.current === current) unlisten = cleanup;
          else cleanup();
        }).catch((error: unknown) => {
          if (lifetime.current === current) setMsg(`Dateiablage konnte nicht eingerichtet werden: ${String(error)}`);
        });
    }
    return () => { lifetime.current = null; unlisten?.(); };
  }, [importDocuments, reloadDocs]);

  const openRel = async (rel: string) => {
    if (!isSafeRelativePath(rel)) {
      setMsg("Unsicherer Dateipfad wurde blockiert.");
      return;
    }
    try {
      await apiOpenVaultFile(`${await terminDir(cfg, event.terminRel)}/${rel}`);
    } catch (error) {
      setMsg(`Öffnen fehlgeschlagen: ${String(error)}`);
    }
  };

  const openWiki = async (target: string) => {
    setMsg(null);
    try {
      const current = { path: `${cfg.semester}/${event.terminRel}/${event.noteFile ?? "notes.md"}`, subjectKey: event.fachKey };
      const link = resolveKnowledgeTarget(target, current, knowledgeNotes, events, cfg.semester);
      if (link.kind === "heading") {
        const heading = [...document.querySelectorAll(".fach-main .md-preview :is(h1,h2,h3,h4,h5,h6)")].find((element) => element.textContent === link.heading);
        heading?.scrollIntoView({ block: "start", behavior: "smooth" });
      } else if (link.kind === "note") onOpenKnowledge(link.path);
      else if (link.kind === "event") onOpen(link.uid);
      else if (link.kind === "subject") onOpenSubject(link.key, link.name);
      else if (link.kind === "document") await apiOpenVaultFile(await join(cfg.basisPfad, link.path));
      else await invoke("open_knowledge_file", { path: await join(cfg.basisPfad, link.path) });
    } catch { setMsg("Verknüpfte Datei konnte nicht geöffnet werden. Bitte Pfad und Datei im Vault prüfen."); }
  };

  const trackSel = () => {
    const el = taRef.current;
    if (el) selRef.current = { s: el.selectionStart ?? 0, e: el.selectionEnd ?? 0 };
  };

  const done = (status.vorbereitet ? 1 : 0) + (status.nachbereitet ? 1 : 0);

  // Alle Termine desselben Fachs (für den Kalender-Wechsler), chronologisch.
  const fachEvents = useMemo(
    () =>
      events
        .filter((e) => e.fachKey === event.fachKey)
        .sort((a, b) => a.start.localeCompare(b.start)),
    [events, event.fachKey],
  );

  // Quote-Kopf als reine Anzeige (ohne `>`-Marker) über dem Editor.
  const headLines = head
    .split("\n")
    .map((l) => l.replace(/^>\s?/, ""))
    .filter((l) => l.trim() !== "");
  const previewText = fullBody;

  return (
    <div className="fach fach-wide">
      <button className="backbtn" onClick={() => {
        if (pending) setMsg("Die letzten Änderungen sind nur im Arbeitsspeicher. Bitte zuerst sichern oder den lokalen Entwurf erneut sichern.");
        else onBack();
      }}>
        <IconBack size={16} />
        {backLabel}
      </button>

      <div className="fach-head stagger" style={{ ["--d" as string]: "0ms" }}>
        <span className="fach-dot" style={{ background: `hsl(${hue} 70% 50%)` }} />
        <div>
          <h1 className="title sm">{event.fach}</h1>
          <p className="subtitle">
            {formatTag(event.start)}, {formatZeit(event.start)} – {formatZeit(event.end)} ·{" "}
            {event.typ}
          </p>
        </div>
      </div>

      {knowledge}

      <div className="progress stagger" style={{ ["--d" as string]: "60ms" }}>
        <div className="progress-track">
          <div
            className="progress-fill"
            style={{
              width: `${(done / 2) * 100}%`,
              background: `hsl(${hue} 70% 50%)`,
            }}
          />
        </div>
        <span>{done === 2 ? "Abgeschlossen" : done === 1 ? "Halbzeit" : "Noch offen"}</span>
      </div>

      {conflict && (
        <div className="banner-conflict" role="alert">
          <p>
            <strong>Die Datei wurde extern geändert.</strong> Dein eigener Entwurf ist noch da.
            Du kannst den aktuellen Stand laden und deinen Entwurf verwerfen oder deine Version geprüft speichern.
          </p>
          <div className="banner-actions">
            <button className="primary" onClick={() => void editor.loadTheirs()} disabled={saving || discarding || !!readError}>
              Obsidian-Stand laden
            </button>
            <button className="ghostbtn" onClick={() => void editor.keepMine()} disabled={saving || discarding || !!readError}>
              Meine Version behalten
            </button>
          </div>
        </div>
      )}

      {readError && (
        <div className="banner-conflict" role="alert">
          <p>{readError}</p>
          <div className="banner-actions">
            <button className="ghostbtn" onClick={() => void editor.refresh()} disabled={saving || discarding}>Erneut laden</button>
            {canCreate && <button className="primary" onClick={() => void create()} disabled={saving}>Notiz anlegen</button>}
          </div>
        </div>
      )}
      {draftError && (
        <div className="banner-conflict" role="alert">
          <p>{draftError}</p>
          {pending && <p>Die letzten Änderungen sind nur im Arbeitsspeicher. Diese Ansicht bitte offen lassen.</p>}
          <button className="ghostbtn" onClick={editor.retryDraft}>Entwurf erneut sichern</button>
        </div>
      )}

      <section className="card status-card stagger" style={{ ["--d" as string]: "90ms" }}>
        <CheckRow
          label="Vorbereitet"
          sub="Alle Kästchen unter „Vorbereitung“ — hier oder in Obsidian"
          checked={status.vorbereitet}
          disabled={!editable || saving || !!conflict}
          onToggle={() => void editor.toggle("vorbereitet")}
        />
        <div className="hairline" />
        <CheckRow
          label="Nachbereitet"
          sub="Alle Kästchen unter „Nachbereitung“ — hier oder in Obsidian"
          checked={status.nachbereitet}
          disabled={!editable || saving || !!conflict}
          onToggle={() => void editor.toggle("nachbereitet")}
        />
      </section>

      <QuizPractice key={JSON.stringify([cfg.basisPfad, cfg.semester, event.uid])} cfg={cfg} event={event} />

      <div className="fach-grid">
        <div className="fach-main">
          <div className="notes-head stagger" style={{ ["--d" as string]: "130ms" }}>
            <h3 className="section tight">Notizen</h3>
            <div className="notes-tools">
              <span className={`savestate ${dirty ? "dirty" : ""}`}>
                {!loaded ? "Nicht geladen" : dirty ? pending ? "Nur im Arbeitsspeicher" : "Lokaler Entwurf" : "Gespeichert"}
              </span>
              <div className="segmented sm" role="tablist" aria-label="Notiz-Ansicht">
                <button
                  role="tab"
                  aria-selected={!preview}
                  className={!preview ? "on" : ""}
                  onClick={() => setPreview(false)}
                >
                  Schreiben
                </button>
                <button
                  role="tab"
                  aria-selected={preview}
                  className={preview ? "on" : ""}
                  onClick={() => setPreview(true)}
                >
                  Lesen
                </button>
              </div>
            </div>
          </div>
          <section className="card padless stagger" style={{ ["--d" as string]: "150ms" }}>
            {preview ? (
              <MdPreview text={previewText} onOpenFile={openRel} onOpenWiki={(target) => void openWiki(target)} onOpenLink={(url) => {
                if (/^https?:\/\//i.test(url)) void apiOpenExternalUrl(url).catch((error: unknown) => setMsg(`Link konnte nicht geöffnet werden: ${String(error)}`));
                else void openWiki(url);
              }} />
            ) : (
              <>
                {headLines.length > 0 && (
                  <div className="note-head" aria-label="Termin-Info">
                    {headLines.map((l, i) => (
                      <p key={i}>{l}</p>
                    ))}
                  </div>
                )}
                <textarea
                  ref={taRef}
                  className="editor"
                  value={body}
                  readOnly={!editable}
                  onChange={(e) => {
                    editor.edit(prefix + e.currentTarget.value);
                  }}
                  onSelect={trackSel}
                  onKeyUp={trackSel}
                  onClick={trackSel}
                  spellCheck={false}
                  aria-label="Notizen (Markdown)"
                />
              </>
            )}
            <div className="editor-bar">
              <span className="row-sub">Markdown · {event.noteFile ?? "Notiz"} · Obsidian-kompatibel</span>
              <button className="primary" onClick={() => void editor.save()} disabled={!dirty || saving || !!conflict || !editable}>
                {saving ? "Speichert …" : "Sichern"}
              </button>
            </div>
          </section>

          <p className="meta-line stagger" style={{ ["--d" as string]: "170ms" }}>
            <IconClock size={13} />
            {event.lvNummer && <span>LV {event.lvNummer} · </span>}
            <span>{event.dozent} · </span>
            <code>{event.terminRel}</code>
          </p>
        </div>

        <aside className="fach-side">
          <h3 className="section stagger" style={{ ["--d" as string]: "130ms" }}>
            Kalender
          </h3>
          <div className="stagger" style={{ ["--d" as string]: "150ms" }}>
            <FachKalender
              events={fachEvents}
              currentUid={event.uid}
              hue={hue}
              onOpen={(uid) => {
                if (pending) setMsg("Bitte zuerst die Änderungen sichern. Der lokale Entwurf konnte nicht gespeichert werden.");
                else onOpen(uid);
              }}
            />
          </div>
          <h3 className="section stagger" style={{ ["--d" as string]: "170ms" }}>
            Dokumente
          </h3>
          <section className="card stagger" style={{ ["--d" as string]: "150ms" }}>
            <div
              className={dragOver ? "dropzone over" : "dropzone"}
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragOver(false);
                setMsg("Dateien bitte direkt auf das Fenster ziehen (Desktop-App).");
              }}
            >
              <IconFolder size={26} />
              <p>
                <strong>Dateien hierher ziehen</strong>
                <span>Sie landen in docs/ + als Verweis in der Notiz</span>
              </p>
            </div>
            <button className="ghostbtn" disabled={!editable} onClick={async () => {
              const current = lifetime.current;
              try {
                const paths = await apiPickDocuments();
                if (current && lifetime.current === current) await importDocuments(paths);
              } catch (error) {
                if (current && lifetime.current === current) setMsg(`Dateiauswahl fehlgeschlagen: ${String(error)}`);
              }
            }}>Dateien auswählen …</button>
            {docs.length > 0 && (
              <ul className="doclist">
                {docs.map((d) => (
                  <li key={d.path}>
                    <span className="docicon">
                      <IconDoc size={18} />
                    </span>
                    <span className="row-main">
                      <strong>{d.name}</strong>
                      <span className="row-sub">{Math.round(d.size / 1024)} KB</span>
                    </span>
                    <button
                      className="iconbtn sm"
                      title="Öffnen"
                      onClick={() => apiOpenVaultFile(d.path).catch((error: unknown) => setMsg(`Öffnen fehlgeschlagen: ${String(error)}`))}
                    >
                      <IconOpen size={15} />
                    </button>
                    <button
                      className="iconbtn sm"
                      title="Im Finder zeigen"
                      onClick={() =>
                        apiRevealVaultPath(d.path).catch((error: unknown) => setMsg(`Finder öffnen fehlgeschlagen: ${String(error)}`))
                      }
                    >
                      <IconFolder size={15} />
                    </button>
                    <button
                      className="iconbtn sm danger"
                      title="In den Vault-Papierkorb verschieben"
                      disabled={!editable}
                      onClick={async () => {
                        try {
                          await apiDeleteFile(d.path);
                          setMsg("Datei in .mci-manager/trash verschoben. Dort kann sie wiederhergestellt werden.");
                          await reloadDocs();
                        } catch (error) {
                          setMsg(`Löschen fehlgeschlagen: ${String(error)}`);
                        }
                      }}
                    >
                      <IconTrash size={15} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </aside>
      </div>
      {message && <p className="toast" role="status">{message}</p>}
      {msg && <p className="toast" role="status">{msg}</p>}
    </div>
  );
}
