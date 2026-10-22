import { subjectFileName } from "./filenames";
import { buildFaecher } from "./ical";
import { knowledgePath, resolveKnowledgeLink, type KnowledgeNote } from "./knowledge";
import type { StudyEvent } from "./types";

type KnowledgeTarget =
  | { kind: "heading"; heading: string }
  | { kind: "note"; path: string }
  | { kind: "event"; uid: string }
  | { kind: "subject"; key: string; name: string }
  | { kind: "document" | "file"; path: string };

export function resolveKnowledgeTarget(target: string, current: Pick<KnowledgeNote, "path" | "subjectKey">,
  notes: KnowledgeNote[], events: StudyEvent[], semester: string): KnowledgeTarget {
  const link = resolveKnowledgeLink(target, current.path);
  if (link.path === current.path && link.heading) return { kind: "heading", heading: link.heading };
  if (notes.some((note) => note.path === link.path)) return { kind: "note", path: link.path + (link.heading ? `#${link.heading}` : "") };
  const event = events.find((event) => link.path === `${semester}/${event.terminRel}/${event.noteFile ?? "notes.md"}`);
  if (event) return { kind: "event", uid: event.uid };
  const subject = buildFaecher(events).find((subject) => link.path === `${semester}/${subject.dir}/${subject.file ?? subjectFileName(subject.name)}`);
  if (subject) return { kind: "subject", key: subject.key, name: subject.name };
  const noteParts = knowledgePath(current.path).split("/");
  const ownDocument = current.subjectKey && noteParts.length === 4 && noteParts[0] === semester && /\.md$/i.test(noteParts[3])
    && link.path.startsWith(`${noteParts.slice(0, 3).join("/")}/docs/`);
  const knownDocument = events.some((event) => link.path.startsWith(`${semester}/${event.terminRel}/docs/`));
  if (link.path.split("/").length === 5 && (ownDocument || knownDocument)) return { kind: "document", path: link.path };
  return { kind: "file", path: link.path };
}
