import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { join } from "@tauri-apps/api/path";
import type { AppConfig, StudyEvent } from "../lib/types";
import type { useSakai } from "../hooks/useSakai";
import { apiOpenExternalUrl, apiOpenVaultFile } from "../lib/storage";
import type { KnowledgeNote } from "../lib/knowledge";
import { resolveKnowledgeTarget } from "../lib/knowledgeLinks";
import { MdPreview } from "./MdPreview";
import { SakaiPanel } from "./SakaiPanel";
import { IconBack, IconChevron, IconDoc, IconOpen, IconSync } from "./icons";

function dateLabel(value: string | null): string {
  if (!value) return "Abrufdatum unbekannt";
  return `Abruf ${new Date(`${value}T12:00:00Z`).toLocaleDateString("de-AT")}`;
}

function KnowledgeReader({ note, notes, cfg, events, heading, onSelect, onOpenSubject, onOpenEvent }: {
  note: KnowledgeNote; notes: KnowledgeNote[]; cfg: AppConfig; events: StudyEvent[]; heading: string | null; onSelect: (path: string) => void;
  onOpenSubject: (key: string, name: string) => void; onOpenEvent: (uid: string) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const subjectName = events.find((event) => event.fachKey === note.subjectKey)?.fach ?? note.subject ?? note.subjectKey;
  useEffect(() => {
    if (!heading) return;
    const target = [...document.querySelectorAll(".knowledge-reader :is(h1,h2,h3,h4,h5,h6)")].find((element) => element.textContent === heading);
    target?.scrollIntoView({ block: "start" });
  }, [heading, note.body]);
  const openLocal = async (target: string) => {
    setError(null);
    try {
      const link = resolveKnowledgeTarget(target, note, notes, events, cfg.semester);
      if (link.kind === "heading") {
        const heading = [...document.querySelectorAll(".knowledge-reader :is(h1,h2,h3,h4,h5,h6)")].find((element) => element.textContent === link.heading);
        heading?.scrollIntoView({ block: "start", behavior: "smooth" });
      } else if (link.kind === "note") onSelect(link.path);
      else if (link.kind === "event") onOpenEvent(link.uid);
      else if (link.kind === "subject") onOpenSubject(link.key, link.name);
      else if (link.kind === "document") await apiOpenVaultFile(await join(cfg.basisPfad, link.path));
      else await invoke("open_knowledge_file", { path: await join(cfg.basisPfad, link.path) });
    } catch { setError("Verknüpfte Datei konnte nicht geöffnet werden. Bitte Pfad und Datei im Vault prüfen."); }
  };
  const openExternal = async (url: string) => {
    setError(null);
    if (!/^https?:\/\//i.test(url)) { await openLocal(url); return; }
    try { await apiOpenExternalUrl(url); }
    catch { setError("Weblink konnte nicht geöffnet werden."); }
  };
  const openOriginal = async () => {
    setError(null);
    try { await invoke("open_knowledge_file", { path: await join(cfg.basisPfad, note.path) }); }
    catch { setError("Originalnotiz konnte nicht geöffnet werden."); }
  };
  return (
    <article className="knowledge-reader">
      <div className="knowledge-meta">
        {note.subjectKey && subjectName && <><span className="pill">Fach: {subjectName}</span><button className="knowledge-link" onClick={() => onOpenSubject(note.subjectKey!, subjectName)}>Zum Fach <IconChevron size={14} /></button></>}
        <span className="pill">{dateLabel(note.retrievedAt)}</span>
        {note.cohort && <span className="pill">JG{note.cohort}</span>}
        <button className="knowledge-link" onClick={() => void openOriginal()}><IconOpen size={14} /> Originalnotiz öffnen</button>
      </div>
      {note.sourceStatus && <p className="banner-info">Quellenstand: {note.sourceStatus}</p>}
      {note.applicability && <p className="prep-hint">Geltung: {note.applicability}</p>}
      {error && <p className="banner-error" role="alert">{error}</p>}
      <MdPreview text={note.body} onOpenFile={(path) => void openLocal(path)} onOpenWiki={(path) => void openLocal(path)} onOpenLink={(url) => void openExternal(url)} />
      <p className="prep-hint">Leseansicht. Änderungen an Text und Kästchen bitte in der Originalnotiz vornehmen. Sie werden beim Fensterfokus oder spätestens nach 30 Sekunden neu eingelesen.</p>
    </article>
  );
}

interface Props {
  sakai?: ReturnType<typeof useSakai>;
  events?: StudyEvent[];
  cfg: AppConfig;
  notes: KnowledgeNote[];
  warnings: string[];
  loading: boolean;
  selectedPath?: string;
  subjectKey?: string;
  onBack: () => void;
  onReload: () => void;
  onSelect: (path: string) => void;
  onOpenSubject: (key: string, name: string) => void;
  onOpenEvent: (uid: string) => void;
  onShowAll: () => void;
}

export function KnowledgeView({ cfg, notes, warnings, loading, selectedPath, subjectKey, onBack, onReload, onSelect, onOpenSubject, onOpenEvent, onShowAll, sakai, events = [] }: Props) {
  const headingRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "study" | "courses">("all");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!selectedPath?.includes("#")) headingRef.current?.closest("main")?.scrollTo({ top: 0 });
  }, [selectedPath]);
  const [path, ...headings] = (selectedPath ?? "").split("#");
  const selected = notes.find((note) => note.path === path);
  const visible = notes.filter((note) => (!subjectKey || note.subjectKey === subjectKey)
    && (filter === "all" || (filter === "study" ? !note.subjectKey : Boolean(note.subjectKey)))
    && `${note.title} ${note.subject ?? ""} ${note.body}`.toLocaleLowerCase("de").includes(query.trim().toLocaleLowerCase("de")));
  const openSakai = async () => {
    try { await apiOpenExternalUrl("https://sakai.mci4me.at/portal"); setError(null); }
    catch { setError("Sakai konnte nicht im Browser geöffnet werden."); }
  };
  return (
    <>
      <button className="backbtn" onClick={onBack}><IconBack size={16} /> Zurück</button>
      <div className="knowledge-heading" ref={headingRef}>
        <div><h1 className="title">Sakai & Studienwissen</h1><p className="subtitle">{notes.length} Notizen aus deinem Vault</p></div>
        <div className="knowledge-actions">
          <button className="knowledge-link" onClick={onReload} disabled={loading}><IconSync size={14} /> Vault neu einlesen</button>
          <button className="knowledge-link" onClick={() => void openSakai()}><IconOpen size={14} /> Sakai öffnen</button>
        </div>
      </div>
      {sakai && !selected && !subjectKey && <SakaiPanel sync={sakai} events={events} />}
      <p className="knowledge-status">Lokaler Wissensstand aus Obsidian. „Sakai Live“ enthält automatische Quellenimporte. Eigene Notizen und Zusammenfassungen bleiben erhalten. Maßgeblich ist das Abrufdatum der jeweiligen Notiz.</p>
      {error && <p className="banner-error" role="alert">{error}</p>}
      {warnings.length > 0 && <div className="banner-error" role="alert">{warnings.map((warning, index) => <p key={`${index}:${warning}`}>{warning}</p>)}</div>}
      {loading && <p className="prep-hint" role="status">Wissensnotizen werden eingelesen …</p>}
      {(selectedPath || subjectKey) && <button className="knowledge-link knowledge-back" onClick={onShowAll}><IconBack size={14} /> Alle Wissensnotizen</button>}
      {selected ? <KnowledgeReader key={selected.path} note={selected} notes={notes} cfg={cfg} events={events} heading={headings.join("#") || null} onSelect={onSelect} onOpenSubject={onOpenSubject} onOpenEvent={onOpenEvent} /> : (
        <>
          {selectedPath && !loading && <p className="banner-info">Diese Notiz ist nicht mehr verfügbar oder konnte nicht gelesen werden.</p>}
          <div className="knowledge-filters">
            <input className="knowledge-search" aria-label="Studienwissen durchsuchen" placeholder="In Titeln und Inhalten suchen" value={query} onChange={(event) => setQuery(event.target.value)} />
            <select aria-label="Wissensbereich" value={filter} onChange={(event) => setFilter(event.target.value as typeof filter)}>
              <option value="all">Alle Bereiche</option><option value="study">Studium</option><option value="courses">Fächer</option>
            </select>
          </div>
          <div className="grouped knowledge-list">
            {visible.map((note) => <button key={note.path} className="row" onClick={() => onSelect(note.path)}>
              <IconDoc size={20} /><span className="row-main"><strong>{note.title}</strong><span className="row-sub">{note.subjectKey ? note.subject ?? events.find((event) => event.fachKey === note.subjectKey)?.fach ?? note.subjectKey : "Studium"} · {dateLabel(note.retrievedAt)}{note.cohort ? ` · JG${note.cohort}` : ""}</span></span><IconChevron size={15} />
            </button>)}
          </div>
          {!loading && visible.length === 0 && <div className="empty"><IconDoc size={28} /><p>{notes.length ? "Keine passenden Wissensnotizen." : "Noch kein Studienwissen im Vault. Fachnotizen werden aus den bekannten Fach- und Einheitsordnern sowie aus Studium/ eingelesen."}</p></div>}
        </>
      )}
    </>
  );
}
