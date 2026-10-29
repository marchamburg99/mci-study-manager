import { describe, expect, it } from "vitest";
import { evaluateQuiz, readLearningQuiz, readLearningRecord, type LearningQuiz } from "../src/lib/learning";

export const learningQuiz: LearningQuiz = {
  version: 1, id: "artifact-1", eventUid: "lesson-1", subjectKey: "databases", title: "Datenbank-Grundlagen",
  createdAt: "2026-10-29T15:00:00Z", notebookId: "notebook-1", artifactId: "artifact-1",
  sourcePaths: ["Sem01/01-databases/lesson-1/Zusammenfassung.md"],
  questions: [
    { id: "q1", topic: "Primary keys", prompt: "Wozu dient ein Primärschlüssel?", options: ["Eindeutige Identifikation", "Sortierung"], correctIndex: 0, explanation: "Ein Primärschlüssel identifiziert einen Datensatz eindeutig." },
    { id: "q2", topic: "Foreign keys", prompt: "Was sichert ein Fremdschlüssel?", options: ["Alphabetische Reihenfolge", "Referentielle Integrität"], correctIndex: 1, explanation: "Er verweist auf einen Schlüssel einer anderen Relation." },
  ],
};
const event = { uid: "lesson-1", fachKey: "databases" };

describe("learning evidence", () => {
  it("derives weak topics from actual answers and accepts zero as an answer", () => {
    const quiz = readLearningQuiz(JSON.stringify(learningQuiz), event);
    expect(evaluateQuiz(quiz, { q1: 0, q2: 0 })).toMatchObject({ correct: 1, total: 2, weakTopics: ["Foreign keys"] });
    expect(evaluateQuiz(quiz, { q1: 0, q2: 1 }).weakTopics).toEqual([]);
  });

  it.each([{ q1: 0 }, { q1: 0, q2: 99 }, { q1: 0, q2: 0.5 }, { q1: 0, q2: 1, q3: 1 }])("rejects incomplete or invalid answers: %j", (answers) => {
    expect(() => evaluateQuiz(learningQuiz, answers as Record<string, number>)).toThrow();
  });

  it.each([
    { eventUid: "another-lesson" }, { subjectKey: "coding" }, { version: 2 }, { questions: [] },
    { questions: [{ ...learningQuiz.questions[0], correctIndex: 3 }] },
    { questions: [learningQuiz.questions[0], learningQuiz.questions[0]] },
    { questions: [{ ...learningQuiz.questions[0], options: ["same", "same"] }] },
  ])("rejects mismatched identity or invalid answer keys", (changes) => {
    expect(() => readLearningQuiz(JSON.stringify({ ...learningQuiz, ...changes }), event)).toThrow();
  });

  it("distinguishes no attempt file from empty, null and corrupt files", () => {
    expect(readLearningRecord(null, learningQuiz).attempts).toEqual([]);
    for (const raw of ["", "null", "{}", '{"attempts":null}']) {
      expect(() => readLearningRecord(raw, learningQuiz)).toThrow();
    }
  });

  it("does not treat a foreign or malformed attempt as learning evidence", () => {
    const record = { version: 1, quizId: learningQuiz.id, eventUid: "lesson-1", subjectKey: "databases", attempts: [{ completedAt: "2026-10-29T16:00:00Z", answers: { q1: 0, q2: 1 } }] };
    expect(readLearningRecord(JSON.stringify(record), learningQuiz).attempts).toHaveLength(1);
    expect(() => readLearningRecord(JSON.stringify({ ...record, quizId: "other" }), learningQuiz)).toThrow();
    expect(() => readLearningRecord(JSON.stringify({ ...record, attempts: [{ completedAt: "invalid", answers: {} }] }), learningQuiz)).toThrow();
  });
});
