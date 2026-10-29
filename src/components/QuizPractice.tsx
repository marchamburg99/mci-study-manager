import { useEffect, useId, useRef, useState } from "react";
import type { AppConfig, StudyEvent } from "../lib/types";
import type { LearningQuiz, LearningRecord } from "../lib/learning";
import { useLearningQuiz } from "../hooks/useLearningQuiz";
import { evaluateQuiz } from "../lib/learning";
import "./QuizPractice.css";

type Answers = Record<string, number>;

const hasAnswer = (answers: Answers, id: string) => Object.prototype.hasOwnProperty.call(answers, id);

const questionSignature = (quiz: LearningQuiz) => JSON.stringify(quiz.questions.map(({ id, options }) => [id, options]));

function readDraft(key: string, quiz: LearningQuiz): { answers: Answers; exists: boolean; error: string | null } {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return { answers: {}, exists: false, error: null };
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid draft");
    if (!("signature" in value) || value.signature !== questionSignature(quiz) || !("answers" in value) || !value.answers || typeof value.answers !== "object" || Array.isArray(value.answers)) throw new Error("Invalid draft");
    const entries = Object.entries(value.answers);
    const answers: Answers = Object.create(null);
    for (const [id, index] of entries) {
      const question = quiz.questions.find((item) => item.id === id);
      if (!question || typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= question.options.length) {
        throw new Error("Invalid draft");
      }
      answers[id] = index;
    }
    return { answers, exists: true, error: null };
  } catch {
    return { answers: {}, exists: false, error: "Der lokale Entwurf konnte nicht geladen werden. Du kannst neu beginnen; bisherige Antworten sind möglicherweise noch im lokalen Speicher." };
  }
}

function QuizSession({ quiz, record, storageKey, saving, submit }: {
  quiz: LearningQuiz;
  record: LearningRecord | null;
  storageKey: string;
  saving: boolean;
  submit: (answers: Answers) => Promise<boolean>;
}) {
  const [draft] = useState(() => readDraft(storageKey, quiz));
  const latest = record?.attempts[record.attempts.length - 1];
  const [answers, setAnswers] = useState<Answers>(draft.answers);
  const [resultAnswers, setResultAnswers] = useState<Answers | null>(() => draft.exists ? null : latest?.answers ?? null);
  const [index, setIndex] = useState(() => Math.max(0, quiz.questions.findIndex((question) => !hasAnswer(draft.answers, question.id))));
  const [storageError, setStorageError] = useState(draft.error);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [completedAt, setCompletedAt] = useState<string | null>(() => draft.exists ? null : latest?.completedAt ?? null);
  const [focusVersion, setFocusVersion] = useState(0);
  const focusTarget = useRef<HTMLHeadingElement>(null);
  const lifetime = useRef<object | null>(null);
  const submitting = useRef(false);
  const questionName = useId();
  const question = quiz.questions[index];
  const answered = quiz.questions.filter((item) => hasAnswer(answers, item.id)).length;
  const result = resultAnswers ? evaluateQuiz(quiz, resultAnswers) : null;

  useEffect(() => {
    const current = {};
    lifetime.current = current;
    return () => { lifetime.current = null; };
  }, []);

  useEffect(() => {
    if (focusVersion > 0) focusTarget.current?.focus();
  }, [focusVersion]);

  const persist = (next: Answers) => {
    try {
      localStorage.setItem(storageKey, JSON.stringify({ signature: questionSignature(quiz), answers: next }));
      setStorageError(null);
    } catch {
      setStorageError("Deine Antworten sind nur im Arbeitsspeicher. Lokales Sichern ist fehlgeschlagen. Lass diese Ansicht offen oder versuche es erneut.");
    }
  };

  const move = (next: number) => {
    setIndex(next);
    setFocusVersion((version) => version + 1);
  };

  const finish = async () => {
    if (submitting.current || saving || answered !== quiz.questions.length) return;
    const current = lifetime.current;
    submitting.current = true;
    setSaveError(null);
    try {
      const saved = await submit(answers);
      if (!current || lifetime.current !== current) return;
      if (!saved) {
        setSaveError("Ergebnis konnte nicht gespeichert werden. Deine Antworten bleiben erhalten. Bitte erneut speichern.");
        return;
      }
      setResultAnswers({ ...answers });
      setCompletedAt(new Date().toISOString());
      setFocusVersion((version) => version + 1);
      try {
        localStorage.removeItem(storageKey);
        setStorageError(null);
      } catch {
        setStorageError("Das Ergebnis ist gespeichert. Der lokale Entwurf konnte jedoch nicht entfernt werden.");
      }
    } catch {
      if (current && lifetime.current === current) setSaveError("Ergebnis konnte nicht gespeichert werden. Deine Antworten bleiben erhalten. Bitte erneut speichern.");
    } finally {
      if (current && lifetime.current === current) submitting.current = false;
    }
  };

  const repeat = () => {
    setAnswers({});
    setResultAnswers(null);
    setSaveError(null);
    setCompletedAt(null);
    setIndex(0);
    persist({});
    setFocusVersion((version) => version + 1);
  };

  return <>
    {storageError && <div className="quiz-notice" role="alert">
      <p>{storageError}</p>
      {!result && <button type="button" className="ghostbtn" onClick={() => persist(answers)}>Entwurf erneut sichern</button>}
    </div>}
    {result ? <div className="quiz-result">
      <h3 ref={focusTarget} tabIndex={-1}>Dein Ergebnis: {result.correct} von {result.total} richtig</h3>
      <p className="quiz-meta">Gespeichert{completedAt && !Number.isNaN(Date.parse(completedAt)) ? ` · ${new Date(completedAt).toLocaleString("de-AT", { dateStyle: "short", timeStyle: "short" })}` : ""}. Für deine nächste Lerneinheit verfügbar.</p>
      <p>{result.weakTopics.length ? `Noch einmal üben: ${result.weakTopics.join(", ")}` : "Alle Fragen richtig beantwortet. Prüfe dein Wissen beim nächsten Mal an neuen Beispielen."}</p>
      <details className="quiz-review">
        <summary>Antworten und Erklärungen ansehen</summary>
        <ol>{result.items.map((item) => {
          const reviewed = quiz.questions.find((entry) => entry.id === item.questionId);
          return <li key={item.questionId}>
            <strong>{item.correct ? "Richtig" : "Noch üben"}: {reviewed?.prompt}</strong>
            <p>Deine Antwort: {reviewed?.options[item.selectedIndex] ?? "Keine Antwort"}</p>
            {!item.correct && <p>Richtige Antwort: {reviewed?.options[item.correctIndex]}</p>}
            <p>{item.explanation}</p>
          </li>;
        })}</ol>
      </details>
      <button type="button" className="ghostbtn" onClick={repeat} disabled={saving}>Erneut üben</button>
    </div> : <form onSubmit={(event) => { event.preventDefault(); if (saving || !hasAnswer(answers, question.id)) return; if (index < quiz.questions.length - 1) move(index + 1); else void finish(); }}>
      <div className="quiz-progress-label"><span>Frage {index + 1} von {quiz.questions.length}</span><span>{answered} beantwortet</span></div>
      <progress className="quiz-progress" max={quiz.questions.length} value={answered} aria-label="Beantwortete Fragen" />
      <h3 id={`${questionName}-prompt`} className="quiz-question" ref={focusTarget} tabIndex={-1}>{question.prompt}</h3>
      <fieldset className="quiz-options" aria-labelledby={`${questionName}-prompt`} disabled={saving}>
        <legend className="quiz-meta">Eine Antwort auswählen</legend>
        {question.options.map((option, optionIndex) => <label className={`quiz-option${answers[question.id] === optionIndex ? " selected" : ""}`} key={optionIndex}>
          <input type="radio" name={`${questionName}-${question.id}`} value={optionIndex} checked={answers[question.id] === optionIndex} onChange={() => {
            const next = { ...answers, [question.id]: optionIndex };
            setAnswers(next);
            persist(next);
            setSaveError(null);
          }} />
          <span>{option}</span>
        </label>)}
      </fieldset>
      {saveError && <p className="quiz-notice" role="alert">{saveError}</p>}
      <div className="quiz-actions">
        <button type="button" className="ghostbtn" disabled={saving || index === 0} onClick={() => move(index - 1)}>Zurück</button>
        <button type="submit" className="primary" disabled={saving || !hasAnswer(answers, question.id) || (index === quiz.questions.length - 1 && answered !== quiz.questions.length)}>
          {saving ? "Wird gespeichert …" : index < quiz.questions.length - 1 ? "Weiter" : saveError ? "Erneut speichern" : "Quiz abschließen"}
        </button>
      </div>
      <p className="quiz-meta quiz-footer" role="status">{saving ? "Dein Ergebnis wird gespeichert." : "Die Auswertung erscheint, wenn du das Quiz abschließt."}</p>
    </form>}
  </>;
}

export function QuizPractice({ cfg, event }: { cfg: AppConfig; event: StudyEvent }) {
  const { quiz, record, loading, saving, error, refresh, submit } = useLearningQuiz(cfg, event);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const lifetime = useRef<object | null>(null);
  const titleId = useId();
  useEffect(() => {
    const current = {};
    lifetime.current = current;
    return () => { lifetime.current = null; };
  }, [cfg.basisPfad, cfg.semester, event.uid]);
  const reload = async () => {
    const current = lifetime.current;
    setRefreshError(null);
    try { await refresh(); } catch {
      if (current && lifetime.current === current) setRefreshError("Das Quiz konnte nicht geladen werden. Bitte erneut versuchen.");
    }
  };
  const storageKey = JSON.stringify(["study-manager.quiz-draft.v1", cfg.basisPfad, cfg.semester, event.uid, quiz?.id]);
  return <section className="card quiz-practice" aria-labelledby={titleId} aria-busy={loading || saving}>
    <div className="quiz-heading">
      <div><h2 id={titleId}>Lernquiz</h2><p className="quiz-meta">{quiz?.title ?? "Wissen aus dieser Einheit festigen"}</p></div>
      <span className="quiz-source">NotebookLM</span>
    </div>
    {(error || refreshError) && <div className="quiz-notice" role="alert"><p>{error || refreshError}</p>
      <button type="button" className="ghostbtn" disabled={loading || saving} onClick={() => void reload()}>Erneut laden</button>
    </div>}
    {loading && !quiz ? <p role="status" className="quiz-meta">Quiz wird geladen …</p> : quiz && quiz.questions.length > 0 ? <QuizSession key={storageKey} quiz={quiz} record={record} storageKey={storageKey} saving={saving} submit={submit} /> : !error && !refreshError ? <div className="quiz-empty">
      <p>Noch kein Quiz für diese Einheit.</p>
      <p className="quiz-meta">Sag deinem KI-Lernbegleiter „Unterricht vorbei“. Er übergibt Zusammenfassung und Unterlagen an NotebookLM und erstellt dein Quiz.</p>
      <button type="button" className="ghostbtn" onClick={() => void reload()} disabled={loading}>Nach Quiz suchen</button>
    </div> : null}
  </section>;
}
