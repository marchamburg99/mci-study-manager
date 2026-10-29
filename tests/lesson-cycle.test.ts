// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QuizPractice } from "../src/components/QuizPractice";
import type { AppConfig, StudyEvent } from "../src/lib/types";

const cfg = { basisPfad: "/lesson-fixture", semester: "Sem01" } as AppConfig;
const event = { uid: "lesson-1", fachKey: "databases", terminRel: "01-databases/lesson-1" } as StudyEvent;
const dir = "/lesson-fixture/Sem01/01-databases/lesson-1/";
const quiz = {
  version: 1, id: "artifact-1", eventUid: "lesson-1", subjectKey: "databases", title: "Keys",
  createdAt: "2026-10-29T15:00:00Z", notebookId: "notebook-1", artifactId: "artifact-1", sourcePaths: ["source.md"],
  questions: [
    { id: "q1", topic: "Keys", prompt: "What identifies a row?", options: ["Primary key", "Display order"], correctIndex: 0, explanation: "A primary key identifies each row." },
    { id: "q2", topic: "Relations", prompt: "What links two tables?", options: ["Column color", "Foreign key"], correctIndex: 1, explanation: "Foreign keys link relations." },
  ],
};
let root: Root;
let container: HTMLDivElement;
let files: Map<string, string>;
let failSave: boolean;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  files = new Map([[dir + "Lernquiz.json", JSON.stringify(quiz)]]);
  failSave = false;
  mockIPC((command, payload) => {
    const args = payload as Record<string, unknown>;
    if (command === "plugin:path|join") return (args.paths as string[]).join("/");
    if (command === "read_text_file") return files.get(args.path as string) ?? null;
    if (command === "save_text_file") {
      if (failSave) throw "CONFLICT";
      const path = args.path as string;
      if ((files.get(path) ?? null) !== args.expected) throw "CONFLICT";
      files.set(path, args.content as string); return;
    }
    throw new Error(`Unexpected IPC: ${command}`);
  });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove(); clearMocks(); vi.unstubAllGlobals();
});

async function render(current = event) {
  await act(async () => root.render(createElement(QuizPractice, { cfg, event: current, key: current.uid })));
}
async function answer(index: number) {
  await act(async () => (container.querySelectorAll<HTMLInputElement>('input[type="radio"]')[index]).click());
}
async function button(label: string) {
  const target = [...container.querySelectorAll("button")].find((item) => item.textContent === label);
  expect(target, label).toBeDefined();
  await act(async () => target!.click());
}

describe("native lesson quiz cycle", () => {
  it("records actual answers and shows explanations only after a successful finish", async () => {
    await render();
    expect(container.textContent).toContain("What identifies a row?");
    expect(container.textContent).not.toContain("A primary key identifies each row.");
    await answer(0); await button("Weiter");
    expect(document.activeElement?.textContent).toBe("What links two tables?");
    await answer(0); await button("Quiz abschließen");
    expect(container.textContent).toContain("1 von 2 richtig");
    expect(container.textContent).toContain("Noch einmal üben: Relations");
    const saved = JSON.parse(files.get(dir + "Lernquiz-Ergebnisse.json")!);
    expect(saved.attempts[0].answers).toEqual({ q1: 0, q2: 0 });
    expect(saved).toMatchObject({ quizId: quiz.id, eventUid: event.uid, subjectKey: event.fachKey });
    expect(localStorage.length).toBe(0);
    expect(files.size).toBe(2);
  });

  it("retains a failed submission and resumes the local draft after reopening", async () => {
    await render(); await answer(1); await button("Weiter"); await answer(0);
    failSave = true;
    await button("Quiz abschließen");
    expect(container.textContent).toContain("Erneut speichern");
    expect(container.textContent).not.toContain("Dein Ergebnis:");
    expect(container.textContent).not.toContain("Foreign keys link relations.");
    expect(localStorage.length).toBe(1);
    await act(async () => root.unmount()); root = createRoot(container);
    await render();
    expect((container.querySelectorAll<HTMLInputElement>('input[type="radio"]')[1]).checked).toBe(true);
    failSave = false;
    await button("Weiter"); await button("Quiz abschließen");
    expect(container.textContent).toContain("0 von 2 richtig");
    expect(localStorage.length).toBe(0);
  });

  it("preserves earlier attempts when practising again", async () => {
    await render(); await answer(1); await button("Weiter"); await answer(0); await button("Quiz abschließen");
    await button("Erneut üben"); await answer(0); await button("Weiter"); await answer(1); await button("Quiz abschließen");
    const saved = JSON.parse(files.get(dir + "Lernquiz-Ergebnisse.json")!);
    expect(saved.attempts).toHaveLength(2);
    expect(saved.attempts[0].answers).toEqual({ q1: 1, q2: 0 });
    expect(saved.attempts[1].answers).toEqual({ q1: 0, q2: 1 });
  });

  it("shows the empty state for a different unit without leaking the previous quiz", async () => {
    await render(); await answer(0);
    await render({ ...event, uid: "lesson-2", terminRel: "01-databases/lesson-2" });
    expect(container.textContent).toContain("Noch kein Quiz");
    expect(container.textContent).not.toContain("What identifies a row?");
  });
});
