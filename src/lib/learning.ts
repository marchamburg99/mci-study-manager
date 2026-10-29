export interface LearningQuestion {
  id: string;
  prompt: string;
  topic: string;
  options: string[];
  correctIndex: number;
  explanation: string;
  hint?: string;
}

export interface LearningQuiz {
  version: 1;
  id: string;
  eventUid: string;
  subjectKey: string;
  title: string;
  createdAt: string;
  notebookId: string;
  artifactId: string;
  sourcePaths: string[];
  questions: LearningQuestion[];
}

export interface LearningAttempt {
  completedAt: string;
  answers: Record<string, number>;
}

export interface LearningRecord {
  version: 1;
  quizId: string;
  eventUid: string;
  subjectKey: string;
  attempts: LearningAttempt[];
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 20_000;
}

function timestamp(value: unknown): value is string {
  return text(value) && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
}

function parse(raw: string): unknown {
  if (raw.length > 2_000_000) throw new Error("Die Lerndatei ist zu groß.");
  try { return JSON.parse(raw); }
  catch { throw new Error("Die Lerndatei enthält ungültiges JSON."); }
}

export function readLearningQuiz(raw: string, event: { uid: string; fachKey: string }): LearningQuiz {
  const value = parse(raw);
  if (!object(value) || value.version !== 1 || !text(value.id) || value.eventUid !== event.uid
    || value.subjectKey !== event.fachKey || !text(value.title) || !timestamp(value.createdAt)
    || !text(value.notebookId) || !text(value.artifactId) || !Array.isArray(value.sourcePaths)
    || !value.sourcePaths.length || !value.sourcePaths.every(text)
    || !Array.isArray(value.questions) || value.questions.length < 1 || value.questions.length > 50) {
    throw new Error("Das Lernquiz ist beschädigt oder gehört zu einem anderen Termin.");
  }
  const ids = new Set<string>();
  for (const q of value.questions) {
    if (!object(q) || !text(q.id) || !/^[a-zA-Z0-9_-]+$/.test(q.id) || ids.has(q.id)
      || !text(q.prompt) || !text(q.topic) || !Array.isArray(q.options) || q.options.length < 2
      || q.options.length > 10 || !q.options.every(text) || new Set(q.options).size !== q.options.length
      || !Number.isInteger(q.correctIndex) || (q.correctIndex as number) < 0 || (q.correctIndex as number) >= q.options.length
      || typeof q.explanation !== "string" || q.explanation.length > 20_000
      || (q.hint !== undefined && (typeof q.hint !== "string" || q.hint.length > 20_000))) {
      throw new Error("Das Lernquiz enthält eine ungültige Frage oder Lösung.");
    }
    ids.add(q.id);
  }
  return value as unknown as LearningQuiz;
}

export function evaluateQuiz(quiz: LearningQuiz, answers: Record<string, number>) {
  if (!object(answers) || Object.keys(answers).length !== quiz.questions.length
    || quiz.questions.some((q) => !Object.prototype.hasOwnProperty.call(answers, q.id) || !Number.isInteger(answers[q.id])
      || answers[q.id] < 0 || answers[q.id] >= q.options.length)) {
    throw new Error("Bitte jede Frage beantworten, bevor du das Quiz abschließt.");
  }
  const items = quiz.questions.map((q) => ({
    questionId: q.id, topic: q.topic, selectedIndex: answers[q.id], correctIndex: q.correctIndex,
    correct: answers[q.id] === q.correctIndex, explanation: q.explanation,
  }));
  return {
    correct: items.filter((item) => item.correct).length,
    total: items.length,
    weakTopics: [...new Set(items.filter((item) => !item.correct).map((item) => item.topic))],
    items,
  };
}

export function readLearningRecord(raw: string | null, quiz: LearningQuiz): LearningRecord {
  if (raw === null) return { version: 1, quizId: quiz.id, eventUid: quiz.eventUid, subjectKey: quiz.subjectKey, attempts: [] };
  const value = parse(raw);
  if (!object(value) || value.version !== 1 || value.quizId !== quiz.id || value.eventUid !== quiz.eventUid
    || value.subjectKey !== quiz.subjectKey || !Array.isArray(value.attempts) || value.attempts.length > 1000) {
    throw new Error("Die gespeicherten Quiz-Ergebnisse passen nicht zu diesem Quiz.");
  }
  for (const attempt of value.attempts) {
    if (!object(attempt) || !timestamp(attempt.completedAt) || !object(attempt.answers)) {
      throw new Error("Ein gespeicherter Quizversuch ist beschädigt.");
    }
    evaluateQuiz(quiz, attempt.answers as Record<string, number>);
  }
  return value as unknown as LearningRecord;
}
