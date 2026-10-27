import { describe, expect, it } from "vitest";
import { planFolderConsolidation, rewriteMovedLinks } from "../src/lib/folderConsolidation";
import type { SemesterEntry } from "../src/lib/folderConsolidation";
import type { EventType, StudyEvent } from "../src/lib/types";

const event = (uid: string, fach: string, typ: EventType, fachKey: string, start: string): StudyEvent => ({
  uid, fach, typ, fachKey, summary: fach, dozent: "Example", lvNummer: fachKey, start, end: start, fachDir: "x", terminRel: "x/y",
});

const events = [
  event("db1", "Databases", "ILV", "lv-db", "2026-10-05T07:00:00.000Z"),
  event("db2", "Databases", "ILV", "lv-db", "2026-10-06T07:00:00.000Z"),
  event("cu1", "Coding", "UE", "lv-cod", "2026-10-07T07:00:00.000Z"),
  event("cv1", "Coding", "VO", "lv-cod", "2026-10-14T07:00:00.000Z"),
  event("iba1", "Introduction to Business Administration", "VO", "lv-iba", "2026-10-08T07:00:00.000Z"),
];

const paths = {
  db1: "11-databases-ilv_teacher/2026-10-05_databases-ilv",
  db2: "13-geleitetes-selbststudium-databases-ilv_teacher/2026-10-06_databases-ilv",
  cu1: "02-coding-ue_teacher/2026-10-07_coding-ue",
  cv1: "02-coding-ue_teacher/2026-10-14_coding-vo",
  iba1: "16-introduction-to-business-administration-vo_teacher/2026-10-08_introduction-to-business-administration-vo",
};

const rawIndex = JSON.stringify({
  version: 2,
  paths,
  subjects: {
    "databases-ilv": "09-databases-ilv_teacher", "lv-db": "11-databases-ilv_teacher",
    "lv-ilv-old": "13-geleitetes-selbststudium-databases-ilv_teacher", "lv-cod": "02-coding-ue_teacher",
    "coding-vo": "06-coding-vo_teacher", "lv-iba": "16-introduction-to-business-administration-vo_teacher",
  },
  reserved: Object.values(paths),
  files: Object.fromEntries(Object.entries(paths).map(([uid, path]) => [path, `${uid}.md`])),
  subjectFiles: { "lv-db": "Databases.md", "lv-cod": "Coding.md", "lv-iba": "Introduction to Business Administration.md" },
});

const entries: SemesterEntry[] = [
  { path: "00-demo-fach_test", kind: "dir" },
  { path: "00-demo-fach_test/2026-09-16_demo", kind: "dir" },
  { path: "02-coding-ue_teacher", kind: "dir" },
  { path: "02-coding-ue_teacher/Coding.md", kind: "file" },
  { path: "02-coding-ue_teacher/2026-10-14_coding-vo", kind: "dir" },
  { path: "06-coding-vo_teacher", kind: "dir" },
  { path: "06-coding-vo_teacher/2026-10-01_coding-vo", kind: "dir" },
  { path: "09-databases-ilv_teacher", kind: "dir" },
  { path: "09-databases-ilv_teacher/Databases.md", kind: "file" },
  { path: "09-databases-ilv_teacher/Databases - Sakai.md", kind: "file" },
  { path: "09-databases-ilv_teacher/Lernzettel.pdf", kind: "file" },
  { path: "11-databases-ilv_teacher", kind: "dir" },
  { path: "11-databases-ilv_teacher/2026-10-05_databases-ilv", kind: "dir" },
  { path: "13-geleitetes-selbststudium-databases-ilv_teacher", kind: "dir" },
  { path: "16-introduction-to-business-administration-vo_teacher", kind: "dir" },
  { path: "16-introduction-to-business-administration-vo_teacher/Introduction to Business Administration.md", kind: "file" },
];

const plan = planFolderConsolidation({ semester: "Sem01", rawIndex, events, excludedSubjectKeys: new Set(["lv-iba"]), entries });

describe("planFolderConsolidation", () => {
  it("creates exactly one cleanly named folder per subject and course type", () => {
    expect(plan.folders.map(({ dir, title, sources }) => ({ dir, title, sources }))).toEqual([
      { dir: "01-coding-ue", title: "Coding UE", sources: ["02-coding-ue_teacher"] },
      { dir: "02-coding-vo", title: "Coding VO", sources: ["06-coding-vo_teacher"] },
      { dir: "03-databases-ilv", title: "Databases ILV", sources: ["09-databases-ilv_teacher", "11-databases-ilv_teacher", "13-geleitetes-selbststudium-databases-ilv_teacher"] },
    ]);
  });

  it("moves sessions to their own course type, joins duplicates and renames homes last", () => {
    expect(plan.moves).toEqual([
      { from: "02-coding-ue_teacher/2026-10-14_coding-vo", to: "06-coding-vo_teacher/2026-10-14_coding-vo", kind: "session" },
      { from: "09-databases-ilv_teacher/Databases - Sakai.md", to: "11-databases-ilv_teacher/Databases - Sakai.md", kind: "entry" },
      { from: "09-databases-ilv_teacher/Databases.md", to: "11-databases-ilv_teacher/Databases.md", kind: "entry" },
      { from: "09-databases-ilv_teacher/Lernzettel.pdf", to: "11-databases-ilv_teacher/Lernzettel.pdf", kind: "entry" },
      { from: "02-coding-ue_teacher", to: "01-coding-ue", kind: "folder" },
      { from: "06-coding-vo_teacher", to: "02-coding-vo", kind: "folder" },
      { from: "11-databases-ilv_teacher", to: "03-databases-ilv", kind: "folder" },
    ]);
  });

  it("trashes only emptied duplicates and keeps excluded and unknown folders", () => {
    expect(plan.trash).toEqual(["09-databases-ilv_teacher", "13-geleitetes-selbststudium-databases-ilv_teacher"]);
    expect(plan.kept.map((entry) => entry.path)).toEqual(["00-demo-fach_test", "16-introduction-to-business-administration-vo_teacher"]);
  });

  it("points every session to its final folder and drops superseded index keys", () => {
    expect(plan.index.paths).toEqual({
      cu1: "01-coding-ue/2026-10-07_coding-ue",
      cv1: "02-coding-vo/2026-10-14_coding-vo",
      db1: "03-databases-ilv/2026-10-05_databases-ilv",
      db2: "03-databases-ilv/2026-10-06_databases-ilv",
      iba1: paths.iba1,
    });
    expect(plan.index.subjects).toEqual({
      "lv-cod-ue": "01-coding-ue", "lv-cod-vo": "02-coding-vo", "lv-db-ilv": "03-databases-ilv",
      "lv-iba": "16-introduction-to-business-administration-vo_teacher",
    });
    expect(plan.index.subjectFiles).toEqual({
      "lv-cod-ue": "Coding.md", "lv-db-ilv": "Databases.md", "lv-iba": "Introduction to Business Administration.md",
    });
    expect(plan.index.files["02-coding-vo/2026-10-14_coding-vo"]).toBe("cv1.md");
    expect(plan.index.reserved).not.toContain(paths.db2);
  });

  it("moves sessions that left the calendar with the folder they were in", () => {
    const stale = JSON.parse(rawIndex);
    stale.paths.gone = "05-coding-ue_teacher/2026-09-30_coding-ue";
    const moved = planFolderConsolidation({ semester: "Sem01", rawIndex: JSON.stringify(stale), events, excludedSubjectKeys: new Set(["lv-iba"]),
      entries: [...entries, { path: "05-coding-ue_teacher", kind: "dir" }, { path: "05-coding-ue_teacher/2026-09-30_coding-ue", kind: "dir" }] });

    expect(moved.index.paths.gone).toBe("01-coding-ue/2026-09-30_coding-ue");
    expect(moved.moves).toContainEqual({ from: "05-coding-ue_teacher/2026-09-30_coding-ue", to: "02-coding-ue_teacher/2026-09-30_coding-ue", kind: "session" });
    expect(moved.trash).toContain("05-coding-ue_teacher");
  });

  it("never hands out a path that a session without folder already holds in the home", () => {
    const twin = JSON.parse(rawIndex);
    twin.paths.db3 = "11-databases-ilv_teacher/2026-10-06_databases-ilv";
    twin.reserved.push(twin.paths.db3);
    const withTwin = [...events, event("db3", "Databases", "ILV", "lv-db", "2026-10-06T09:00:00.000Z")];
    const result = planFolderConsolidation({ semester: "Sem01", rawIndex: JSON.stringify(twin), events: withTwin,
      excludedSubjectKeys: new Set(["lv-iba"]), entries });

    expect([result.index.paths.db3, result.index.paths.db2]).toEqual([
      "03-databases-ilv/2026-10-06_databases-ilv", "03-databases-ilv/2026-10-06_databases-ilv-2"]);
    expect(new Set(Object.values(result.index.paths)).size).toBe(Object.keys(result.index.paths).length);
  });

  it("keeps an entry in place instead of overwriting the home folder's file", () => {
    const clash = planFolderConsolidation({ semester: "Sem01", rawIndex, events, excludedSubjectKeys: new Set(["lv-iba"]),
      entries: [...entries, { path: "11-databases-ilv_teacher/Lernzettel.pdf", kind: "file" }] });

    expect(clash.kept).toContainEqual({ path: "09-databases-ilv_teacher/Lernzettel.pdf", reason: "Ziel 11-databases-ilv_teacher/Lernzettel.pdf existiert bereits" });
    expect(clash.trash).not.toContain("09-databases-ilv_teacher");
  });
});

describe("planFolderConsolidation for a shared folder from the per-subject layout", () => {
  const shared = [
    event("u1", "Coding", "UE", "lv-cod", "2026-10-07T07:00:00.000Z"),
    event("v1", "Coding", "VO", "lv-cod", "2026-10-08T07:00:00.000Z"),
    event("v2", "Coding", "VO", "lv-cod", "2026-10-15T07:00:00.000Z"),
  ];
  const sharedPaths = { u1: "03-coding/2026-10-07_coding-ue", v1: "03-coding/2026-10-08_coding-vo", v2: "03-coding/2026-10-15_coding-vo" };
  const result = planFolderConsolidation({
    semester: "Sem01",
    rawIndex: JSON.stringify({ version: 2, paths: sharedPaths, subjects: { "lv-cod": "03-coding" }, reserved: Object.values(sharedPaths),
      files: {}, subjectFiles: { "lv-cod": "Coding.md" } }),
    events: shared,
    excludedSubjectKeys: new Set(),
    entries: [
      { path: "03-coding", kind: "dir" },
      { path: "03-coding/Coding.md", kind: "file" },
      { path: "03-coding/2026-10-07_coding-ue", kind: "dir" },
      { path: "03-coding/2026-10-08_coding-vo", kind: "dir" },
    ],
  });

  it("gives the minority course type a folder of its own and moves its sessions there", () => {
    expect(result.folders.map(({ dir, sources }) => ({ dir, sources }))).toEqual([
      { dir: "01-coding-ue", sources: [] },
      { dir: "02-coding-vo", sources: ["03-coding"] },
    ]);
    expect(result.moves).toEqual([
      { from: "03-coding/2026-10-07_coding-ue", to: "01-coding-ue/2026-10-07_coding-ue", kind: "session" },
      { from: "03-coding", to: "02-coding-vo", kind: "folder" },
    ]);
    expect(result.index.paths).toEqual({
      u1: "01-coding-ue/2026-10-07_coding-ue", v1: "02-coding-vo/2026-10-08_coding-vo", v2: "02-coding-vo/2026-10-15_coding-vo" });
    expect(result.index.subjects).toEqual({ "lv-cod-ue": "01-coding-ue", "lv-cod-vo": "02-coding-vo" });
  });
});

describe("rewriteMovedLinks", () => {
  it("follows moved notes, files and renamed folders in wiki and Markdown links", () => {
    const content = [
      "[[Sem01/09-databases-ilv_teacher/Databases|Fach]]",
      "[[Sem01/02-coding-ue_teacher/2026-10-14_coding-vo/2026-10-14 0900 Coding|VO]]",
      "![[Sem01/11-databases-ilv_teacher/2026-10-05_databases-ilv/docs/slides.pdf]]",
      "[Zettel](Sem01/09-databases-ilv_teacher/Lernzettel.pdf)",
      "[[Databases]] and 11-databases-ilv_teacher in prose",
      "[[Sem01/13-geleitetes-selbststudium-databases-ilv_teacher/2026-10-06_databases-ilv/2026-10-06 0900 Databases|Not yet created]]",
    ].join("\n");

    expect(rewriteMovedLinks(content, "Sem01", plan.links)).toBe([
      "[[Sem01/03-databases-ilv/Databases|Fach]]",
      "[[Sem01/02-coding-vo/2026-10-14_coding-vo/2026-10-14 0900 Coding|VO]]",
      "![[Sem01/03-databases-ilv/2026-10-05_databases-ilv/docs/slides.pdf]]",
      "[Zettel](Sem01/03-databases-ilv/Lernzettel.pdf)",
      "[[Databases]] and 11-databases-ilv_teacher in prose",
      "[[Sem01/03-databases-ilv/2026-10-06_databases-ilv/2026-10-06 0900 Databases|Not yet created]]",
    ].join("\n"));
  });

  it("follows moved files in Markdown links with encoded spaces", () => {
    expect(rewriteMovedLinks("[S](Sem01/09-databases-ilv_teacher/Databases%20-%20Sakai.md)", "Sem01", plan.links))
      .toBe("[S](Sem01/03-databases-ilv/Databases%20-%20Sakai.md)");
  });

  it("leaves checksum-protected Sakai notes untouched", () => {
    const content = "<!-- sm:sakai:abc -->\n[[Sem01/09-databases-ilv_teacher/Databases|Fach]]";

    expect(rewriteMovedLinks(content, "Sem01", plan.links)).toBe(content);
  });
});
