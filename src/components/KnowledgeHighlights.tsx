import { useMemo, useState } from "react";
import type { useSakai } from "../hooks/useSakai";
import { upcomingExams, upcomingKnowledge, type KnowledgeNote } from "../lib/knowledge";
import type { AppConfig } from "../lib/types";
import { formatTag, formatZeit } from "../lib/focus";
import { IconChevron, IconDoc } from "./icons";
import { SakaiCourseMaterials } from "./SakaiCourseMaterials";

function examDate(value: string): string {
  return new Date(value.length === 10 ? `${value}T12:00:00` : value).toLocaleDateString("de-AT", {
    day: "2-digit", month: "2-digit", year: "numeric",
  });
}

export function KnowledgeHighlights({ notes, nowMs, semester, loading, warnings, onOpen, onShowAll }: {
  notes: KnowledgeNote[]; nowMs: number; semester: string; loading: boolean; warnings: string[]; onOpen: (path: string) => void; onShowAll: () => void;
}) {
  const [showAllExams, setShowAllExams] = useState(false);
  const exams = useMemo(() => upcomingExams(notes, nowMs, semester), [notes, nowMs, semester]);
  const notices = useMemo(() => upcomingKnowledge(notes, nowMs).slice(0, 5), [notes, nowMs]);
  const examNote = notes.find((note) => note.examSemester === semester && note.notices.some((notice) => notice.category === "pruefung"));
  const visibleExams = showAllExams ? exams : exams.slice(0, 5);
  return (
    <div className="knowledge-highlights">
      <section className="exam-highlights" aria-label="Prüfungen & Abgaben">
        <div className="knowledge-heading"><h3 className="section">Prüfungen & Abgaben</h3>{examNote && <button type="button" className="knowledge-link" onClick={() => onOpen(examNote.path)}>Prüfungsübersicht <IconChevron size={14} /></button>}</div>
        <p className="prep-hint">Anstehende Termine im aktuellen Semester, auch über die nächsten 14 Tage hinaus.</p>
        {loading && notes.length === 0 && <p className="prep-hint">Wissensstand wird gelesen …</p>}
        <div className="grouped exam-list">
          {visibleExams.map((exam) => <button type="button" key={`${exam.note.path}:${exam.id}`} className="row exam-row" onClick={() => onOpen(exam.note.path)}>
            <span className="exam-date"><strong>{examDate(exam.at)}{exam.endDate ? ` bis ${examDate(exam.endDate)}` : ""}</strong><span>{exam.at.length === 10 ? "Uhrzeit offen" : `${exam.kind === "frist" ? "bis " : ""}${formatZeit(exam.at)} Uhr`}</span></span>
            <span className="row-main"><strong>{exam.title}</strong><span className="row-sub">{exam.kind === "frist" ? "Abgabe" : "Prüfung"}{exam.note.group ? ` · Gruppe ${exam.note.group}` : ""}{exam.note.cohort ? ` · JG${exam.note.cohort}` : ""}</span>{exam.detail && <span className="row-sub">{exam.detail}</span>}</span>
            <IconChevron size={15} />
          </button>)}
        </div>
        {exams.length > 5 && <button type="button" className="knowledge-link exam-show-all" aria-expanded={showAllExams} onClick={() => setShowAllExams(!showAllExams)}>{showAllExams ? "Weniger Termine anzeigen" : `Alle ${exams.length} Termine anzeigen`}</button>}
        {!loading && exams.length === 0 && <p className="prep-hint">Keine anstehenden Prüfungstermine oder Abgaben für das aktuelle Semester im lokalen Wissensstand.</p>}
      </section>
      {warnings.length > 0 && <p className="banner-info">Wissensstand teilweise nicht lesbar. Details im Studienwissen.</p>}
      <section className="knowledge-other-highlights" aria-label="Hinweise aus Sakai">
      <div className="knowledge-heading"><h3 className="section">{examNote ? "Weitere Hinweise aus Sakai" : "Aus Sakai"}</h3><button className="knowledge-link" onClick={onShowAll}>Studienwissen <IconChevron size={14} /></button></div>
      <p className="prep-hint">Bestätigte Hinweise der nächsten 14 Tage aus dem lokalen Vault. Keine zusätzlichen Kalenderbuchungen.</p>
      <div className="grouped">
        {notices.map((notice) => <button key={`${notice.note.path}:${notice.id}`} className="row" onClick={() => onOpen(notice.note.path)}>
          <IconDoc size={20} /><span className="row-main"><strong>{notice.title}</strong><span className="row-sub">{formatTag(notice.at)}, {formatZeit(notice.at)}{notice.note.cohort ? ` · JG${notice.note.cohort}` : ""} · {notice.kind === "frist" ? "Frist" : notice.kind === "termin" ? "Termin" : "Hinweis"}</span></span><IconChevron size={15} />
        </button>)}
      </div>
      {!loading && notices.length === 0 && <p className="prep-hint">Keine weiteren bestätigten Hinweise für die nächsten 14 Tage im lokalen Stand. Das ist keine Aussage über neue Meldungen in Sakai.</p>}
      </section>
    </div>
  );
}

export function SubjectKnowledge({ notes, subjectKey, onOpen, cfg, sakai }: {
  notes: KnowledgeNote[];
  subjectKey: string;
  onOpen: (path: string) => void;
  cfg?: AppConfig;
  sakai?: Pick<ReturnType<typeof useSakai>, "connected" | "busy" | "progress" | "error" | "report" | "preferences" | "run" | "beginLogin">;
}) {
  const subjectNotes = notes.filter((note) => note.subjectKey === subjectKey);
  const isLive = (note: KnowledgeNote) => note.isSakaiLive === true;
  const liveNotes = subjectNotes.filter(isLive).sort((a, b) => (b.retrievedAt ?? "").localeCompare(a.retrievedAt ?? ""));
  const current = liveNotes[0];
  const remaining = [...liveNotes.slice(1), ...subjectNotes.filter((note) => !isLive(note))];
  if (subjectNotes.length === 0 && !sakai) return null;
  return (
    <section className="knowledge-subject" aria-label="Unterlagen zum Fach">
      <div className="knowledge-subject-heading">
        <h3>Wissen & Unterlagen zum Fach</h3>
        <p>Sakai-Informationen, Materialien und Notizen für alle Einheiten.</p>
      </div>
      {(current || sakai) && <SakaiCourseMaterials key={`${subjectKey}:${current?.path ?? ""}`} note={current} notes={notes} subjectKey={subjectKey} cfg={cfg} sakai={sakai} onOpen={onOpen} />}
      {remaining.length > 0 && current && <h4 className="subject-knowledge-other">Weitere Notizen & eigene Zusammenfassungen</h4>}
      <ul className="subject-knowledge-grid">
        {remaining.map((note) => <li key={note.path}>
          <button type="button" className="subject-knowledge-card" onClick={() => onOpen(note.path)}>
            <span className="subject-knowledge-icon"><IconDoc size={20} /></span>
            <span className="subject-knowledge-copy">
              <small className="subject-knowledge-kind">{isLive(note) ? "Weiterer Sakai-Abruf" : "Fachnotiz"}</small>
              <strong>{note.title}</strong>
              <span>Notiz öffnen</span>
            </span>
            <IconChevron size={15} />
          </button>
        </li>)}
      </ul>
    </section>
  );
}
