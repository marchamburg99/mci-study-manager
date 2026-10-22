import { describe, expect, it } from "vitest";
import { resolveKnowledgeTarget } from "../src/lib/knowledgeLinks";
import type { KnowledgeNote } from "../src/lib/knowledge";
import type { StudyEvent } from "../src/lib/types";

const event: StudyEvent = {
  uid: "coding", summary: "Coding", fach: "Coding", typ: "ILV", dozent: "Teacher", lvNummer: "COD1",
  fachKey: "coding", fachDir: "01-coding", terminRel: "01-coding/one",
  start: "2026-09-29T07:00:00.000Z", end: "2026-09-29T08:00:00.000Z",
};
const note: KnowledgeNote = {
  path: "Sem01/01-coding/one/Assignment 1.md", title: "Assignment 1", body: "", subjectKey: "coding",
  subject: "Coding", retrievedAt: null, sourceStatus: null, applicability: null, cohort: null, sourceUrls: [], notices: [],
};

describe("resolveKnowledgeTarget", () => {
  it("preserves section targets when selecting another known note", () => {
    expect(resolveKnowledgeTarget(`${note.path}#Vorbereitung`, { ...note, path: "Sem01/01-coding/one/notes.md" }, [note], [event], "Sem01"))
      .toEqual({ kind: "note", path: `${note.path}#Vorbereitung` });
  });

  it("keeps heading links within the current note", () => {
    expect(resolveKnowledgeTarget("#Vorbereitung", note, [note], [event], "Sem01"))
      .toEqual({ kind: "heading", heading: "Vorbereitung" });
  });

  it("prefers a known read-only note over a matching appointment route", () => {
    const indexed = { ...note, path: "Sem01/01-coding/one/notes.md" };
    expect(resolveKnowledgeTarget(indexed.path, note, [indexed], [event], "Sem01"))
      .toEqual({ kind: "note", path: indexed.path });
  });

  it("opens an exact custom appointment note in its class", () => {
    expect(resolveKnowledgeTarget("Sem01/01-coding/one/2026-09-29 Coding", note, [], [{ ...event, noteFile: "2026-09-29 Coding.md" }], "Sem01"))
      .toEqual({ kind: "event", uid: "coding" });
  });

  it("resolves the indexed subject directory and filename", () => {
    expect(resolveKnowledgeTarget("Sem01/01-coding-combined/Coding Überblick", note, [], [{ ...event, subjectDir: "01-coding-combined", subjectFile: "Coding Überblick.md" }], "Sem01"))
      .toEqual({ kind: "subject", key: "coding", name: "Coding" });
  });

  it("allows direct files beside a known note after its appointment disappears", () => {
    expect(resolveKnowledgeTarget("docs/Assignment%201.pptx", note, [note], [], "Sem01"))
      .toEqual({ kind: "document", path: "Sem01/01-coding/one/docs/Assignment 1.pptx" });
  });

  it.each([
    "Sem01/01-coding/unknown/docs/Presentation.pptx",
    "Sem01/01-coding/one/docs/nested/Presentation.pptx",
    "Sem02/01-coding/one/docs/Presentation.pptx",
  ])("does not expand document permissions to %s", (target) => {
    expect(resolveKnowledgeTarget(target, note, [note], [event], "Sem01"))
      .toEqual({ kind: "file", path: target });
  });

  it.each(["docs/../secret.pptx", "docs/%2e%2e/secret.pptx", "%bad", "/tmp/secret.pdf"])("rejects unsafe targets before routing: %s", (target) => {
    expect(() => resolveKnowledgeTarget(target, note, [note], [event], "Sem01")).toThrow();
  });
});
