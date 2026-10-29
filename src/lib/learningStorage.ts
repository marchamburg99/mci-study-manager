import { join } from "@tauri-apps/api/path";
import type { AppConfig, StudyEvent } from "./types";
import { apiReadText, apiSaveText, terminDir } from "./storage";
import { evaluateQuiz, readLearningQuiz, readLearningRecord, type LearningQuiz, type LearningRecord } from "./learning";

export interface LearningSnapshot {
  quiz: LearningQuiz | null;
  record: LearningRecord | null;
  quizRaw: string | null;
  recordRaw: string | null;
}

export async function loadLearningQuiz(cfg: AppConfig, event: StudyEvent): Promise<LearningSnapshot> {
  const dir = await terminDir(cfg, event.terminRel);
  const quizRaw = await apiReadText(await join(dir, "Lernquiz.json"));
  if (quizRaw === null) return { quiz: null, record: null, quizRaw: null, recordRaw: null };
  const quiz = readLearningQuiz(quizRaw, event);
  const recordRaw = await apiReadText(await join(dir, "Lernquiz-Ergebnisse.json"));
  return { quiz, record: readLearningRecord(recordRaw, quiz), quizRaw, recordRaw };
}

export async function saveLearningAttempt(cfg: AppConfig, event: StudyEvent, snapshot: LearningSnapshot,
  answers: Record<string, number>, completedAt = new Date().toISOString()): Promise<LearningSnapshot> {
  const { quiz, record } = snapshot;
  if (!quiz || !record) throw new Error("Bitte zuerst das Lernquiz laden.");
  evaluateQuiz(quiz, answers);
  if (record.attempts.length >= 1000) throw new Error("Für dieses Quiz sind bereits 1000 Versuche gespeichert.");
  const dir = await terminDir(cfg, event.terminRel);
  if (await apiReadText(await join(dir, "Lernquiz.json")) !== snapshot.quizRaw) {
    throw new Error("Das Quiz wurde geändert. Bitte neu laden; deine Antworten bleiben als Entwurf erhalten.");
  }
  const next: LearningRecord = { ...record, attempts: [...record.attempts, { completedAt, answers: { ...answers } }] };
  const recordRaw = JSON.stringify(next, null, 2) + "\n";
  await apiSaveText(await join(dir, "Lernquiz-Ergebnisse.json"), recordRaw, snapshot.recordRaw);
  return { ...snapshot, record: next, recordRaw };
}
