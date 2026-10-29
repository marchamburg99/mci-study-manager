// @vitest-environment happy-dom
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadLearningQuiz, saveLearningAttempt } from "../src/lib/learningStorage";
import { readLearningRecord } from "../src/lib/learning";
import type { AppConfig, StudyEvent } from "../src/lib/types";

const quiz = {
  version: 1, id: "artifact-1", eventUid: "lesson-1", subjectKey: "databases", title: "Databases",
  createdAt: "2026-10-29T15:00:00Z", notebookId: "notebook-1", artifactId: "artifact-1", sourcePaths: ["source.md"],
  questions: [{ id: "q1", topic: "Keys", prompt: "What identifies a row?", options: ["Key", "Index order"], correctIndex: 0, explanation: "A primary key." }],
};
const cfg = { basisPfad: "/test-vault", semester: "Sem01" } as AppConfig;
const event = { uid: "lesson-1", fachKey: "databases", terminRel: "01-databases/lesson-1" } as StudyEvent;
const dir = "/test-vault/Sem01/01-databases/lesson-1/";
const files = new Map<string, string>();
const writes: string[] = [];

beforeEach(() => {
  files.clear(); writes.length = 0;
  files.set(dir + "Lernquiz.json", JSON.stringify(quiz));
  files.set(dir + "Mitschrift.md", "My irreplaceable notes");
  mockIPC((command, payload) => {
    const args = payload as Record<string, unknown>;
    if (command === "plugin:path|join") return (args.paths as string[]).join("/");
    if (command === "read_text_file") return files.get(args.path as string) ?? null;
    if (command === "save_text_file") {
      const path = args.path as string;
      if ((files.get(path) ?? null) !== args.expected) throw "CONFLICT";
      files.set(path, args.content as string); writes.push(path); return;
    }
    throw new Error(`Unexpected IPC ${command}`);
  });
});
afterEach(clearMocks);

describe("learning vault persistence", () => {
  it("stores attempts for the next lesson without touching notes, status or quiz sources", async () => {
    const initial = await loadLearningQuiz(cfg, event);
    const saved = await saveLearningAttempt(cfg, event, initial, { q1: 1 }, "2026-10-29T16:00:00Z");
    await saveLearningAttempt(cfg, event, saved, { q1: 0 }, "2026-10-29T17:00:00Z");
    const loaded = await loadLearningQuiz(cfg, event);
    expect(loaded.record?.attempts.map((attempt) => attempt.answers.q1)).toEqual([1, 0]);
    expect(writes).toEqual([dir + "Lernquiz-Ergebnisse.json", dir + "Lernquiz-Ergebnisse.json"]);
    expect(files.get(dir + "Mitschrift.md")).toBe("My irreplaceable notes");
    expect(files.get(dir + "Lernquiz.json")).toBe(JSON.stringify(quiz));
  });

  it("refuses an outdated write and preserves the other completed attempt", async () => {
    const stale = await loadLearningQuiz(cfg, event);
    const other = await saveLearningAttempt(cfg, event, stale, { q1: 0 });
    await expect(saveLearningAttempt(cfg, event, stale, { q1: 1 })).rejects.toBe("CONFLICT");
    expect(files.get(dir + "Lernquiz-Ergebnisse.json")).toBe(other.recordRaw);
  });

  it("refuses submission when a quiz was changed after reading", async () => {
    const snapshot = await loadLearningQuiz(cfg, event);
    files.set(dir + "Lernquiz.json", JSON.stringify({ ...quiz, id: "new-quiz" }));
    await expect(saveLearningAttempt(cfg, event, snapshot, { q1: 0 })).rejects.toThrow("geändert");
    expect(writes).toEqual([]);
  });

  it("leaves corrupt results untouched", async () => {
    files.set(dir + "Lernquiz-Ergebnisse.json", "null");
    await expect(loadLearningQuiz(cfg, event)).rejects.toThrow();
    expect(writes).toEqual([]);
  });

  it("reports an absent quiz as not generated, without inventing results", async () => {
    files.delete(dir + "Lernquiz.json");
    expect((await loadLearningQuiz(cfg, event)).quiz).toBeNull();
    expect(readLearningRecord(null, quiz as Parameters<typeof readLearningRecord>[1]).attempts).toEqual([]);
  });
});
