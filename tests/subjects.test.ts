import { describe, expect, it } from "vitest";
import { buildFaecher, parseIcs, subjectIdentity, subjectName } from "../src/lib/ical";
import type { EventType } from "../src/lib/types";

function calendar(events: Array<{
  name?: string;
  typ?: EventType;
  teacher?: string;
  lv?: string;
  summary?: string;
}>) {
  return ["BEGIN:VCALENDAR", ...events.map((event, index) => [
    "BEGIN:VEVENT",
    `UID:subject-${index}@example.test`,
    `SUMMARY:${(event.summary ?? `${event.name ?? "Databases"} (${event.typ ?? "ILV"}) - MCiT 26 (${event.teacher ?? "Anna Example"})`)
      .replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/,/g, "\\,").replace(/;/g, "\\;")}`,
    `DESCRIPTION:LV-Nummer: ${event.lv ?? ""}`,
    "DTSTART:20261005T090000",
    "DTEND:20261005T103000",
    "END:VEVENT",
  ].join("\n")), "END:VCALENDAR"].join("\n");
}

describe("subjectName", () => {
  it.each([
    ["Coding VO", "Coding"],
    ["Coding (UE)", "Coding"],
    ["Coding( ilv )", "Coding"],
    ["Computational Thinking I ILV", "Computational Thinking I"],
    ["  geleitetes Selbststudium  Computational\tThinking I (ue)  ", "Computational Thinking I"],
    ["  Einfu\u0308hrung  in\nDatenbanken vo  ", "Einführung in Datenbanken"],
    ["VO", ""],
    ["(UE)", ""],
    ["Geleitetes Selbststudium", ""],
    ["", ""],
  ])("normalizes %s to %s", (name, expected) => {
    expect(subjectName(name)).toBe(expected);
  });

  it.each([
    "VUE", "InVO", "UEberblick", "Coding ILV2", "Coding (VO extra)",
    "VO Coding", "Coding UE Advanced", "Geleitetes SelbststudiumX Coding",
  ])("preserves names without a terminal type token: %s", (name) => {
    expect(subjectName(name)).toBe(name);
  });
});

describe("subjectIdentity", () => {
  it.each([
    ["MCiT-26-M01-101-VO", "mcit-26-m01-101"],
    ["MCiT-26-M01-101-uE", "mcit-26-m01-101"],
    ["MCiT-26-M01-101-ILV", "mcit-26-m01-101"],
    [" \tA\u0308B   001-VO \n", "äb 001"],
    ["AB-VO-101-UE", "ab-vo-101"],
    ["AB-101-VO-extra", "ab-101-vo-extra"],
    ["AB-101-UE2", "ab-101-ue2"],
    ["AB-101_VO", "ab-101_vo"],
    ["AB-101VO", "ab-101vo"],
    ["AB-101 (UE)", "ab-101 (ue)"],
    ["AB-101-SONST", "ab-101-sonst"],
    ["AB-101-VO-UE", "ab-101-vo"],
  ])("normalizes only the terminal LV type suffix in %s", (lv, normalized) => {
    expect(subjectIdentity(lv, "Coding UE")).toBe(JSON.stringify(["lv", normalized]));
  });

  it("uses the canonical name for a missing or whitespace-only LV", () => {
    expect(subjectIdentity("", " Geleitetes Selbststudium  Einfu\u0308hrung VO "))
      .toBe(JSON.stringify(["name", "einführung"]));
    expect(subjectIdentity(" \t\n", "EINFÜHRUNG (UE)"))
      .toBe(JSON.stringify(["name", "einführung"]));
  });
});

describe("parseIcs subject identity", () => {
  it("keeps the same key when teachers change or join the same LV", () => {
    const original = parseIcs(calendar([{ lv: "DB-101", teacher: "Anna Example" }]))[0];
    const replacement = parseIcs(calendar([{ lv: "DB-101", teacher: "Ben Sample" }]))[0];
    const together = parseIcs(calendar([
      { lv: "DB-101", teacher: "Anna Example" },
      { lv: "DB-101", teacher: "Ben Sample" },
    ]));

    expect([replacement.fachKey, ...together.map((event) => event.fachKey)])
      .toEqual([original.fachKey, original.fachKey, original.fachKey]);
    expect(together.map((event) => event.fachDir)).toEqual([original.fachDir, original.fachDir]);
  });

  it("uses a stable display name for multiple titles of the same LV regardless of feed order", () => {
    const variants = [{ lv: "DB-101", name: "Database Systems" }, { lv: "DB-101", name: "Databases" }];
    const events = parseIcs(calendar(variants));
    const reversed = parseIcs(calendar([...variants].reverse()));
    const renamed = parseIcs(calendar([{ lv: "DB-101", name: "Completely New Title" }]));

    expect(new Set(events.map((event) => event.fachKey)).size).toBe(1);
    expect(new Set(events.map((event) => event.fach)).size).toBe(1);
    expect(reversed.map((event) => ({ fach: event.fach, dir: event.fachDir })))
      .toEqual(events.map((event) => ({ fach: event.fach, dir: event.fachDir })));
    expect(renamed[0].fachKey).toBe(events[0].fachKey);
  });

  it("removes the self-study prefix from display and grouping while preserving the original summary", () => {
    const summary = "  Geleitetes Selbststudium   Databases (ILV) - MCiT 26 (Ben Example)  ";
    const events = parseIcs(calendar([
      { lv: "DB-101" },
      { lv: "DB-101", summary },
    ]));

    expect(events.map((event) => event.fach)).toEqual(["Databases", "Databases"]);
    expect(events[1].fachKey).toBe(events[0].fachKey);
    expect(events[1].summary).toBe(summary);
    expect(buildFaecher(events)).toHaveLength(1);
  });

  it("groups self-study events with the same normalized name when the LV is missing", () => {
    const events = parseIcs(calendar([
      { name: "Databases", teacher: "Anna Example" },
      { name: "geleitetes Selbststudium   DATABASES", teacher: "Ben Example" },
    ]));

    expect(events[1].fachKey).toBe(events[0].fachKey);
    expect(events[1].fach).toBe(events[0].fach);
  });

  it.each(["DB-101", undefined])("groups mixed types with LV %s", (lv) => {
    const events = parseIcs(calendar([
      { lv, name: "Coding VO", typ: "VO" },
      { lv, name: "Geleitetes Selbststudium Coding (UE)", typ: "UE" },
      { lv, name: "Coding ILV", typ: "ILV" },
    ]));

    expect(new Set(events.map((event) => event.fachKey)).size).toBe(1);
    expect(events.map((event) => event.fachDir)).toEqual(["01-coding", "01-coding", "01-coding"]);
    expect(buildFaecher(events)).toHaveLength(1);
    expect(buildFaecher(events)[0]).toMatchObject({ name: "Coding", types: ["ILV", "UE", "VO"], termine: 3 });
  });

  it("groups VO, UE and ILV by LV stem while preserving every event's type, summary and LV", () => {
    const variants = [
      { lv: "MCiT-26-M01-101-VO", summary: "Computational Thinking I VO (VO) - MCiT 26 (Anna Example)" },
      { lv: "mcit-26-m01-101-ue", summary: "Geleitetes Selbststudium Computational Thinking I (UE) - MCiT 26 (Ben Example)" },
      { lv: "MCiT-26-M01-101-ILV", summary: "Computational Thinking I (ILV) - MCiT 26 (Chris Example)" },
    ];
    const events = parseIcs(calendar(variants));
    const reversed = parseIcs(calendar([...variants].reverse()));
    const renamed = parseIcs(calendar([{ lv: "MCiT-26-M01-101-UE", name: "Changed Course Title", typ: "UE" }]))[0];
    const standalone = parseIcs(calendar([variants[1]]))[0];

    expect(new Set(events.map((event) => event.fachKey)).size).toBe(1);
    expect(events.map((event) => ({ typ: event.typ, summary: event.summary, lv: event.lvNummer }))).toEqual([
      { typ: "VO", ...variants[0] },
      { typ: "UE", ...variants[1] },
      { typ: "ILV", ...variants[2] },
    ]);
    expect(events.map((event) => event.fach)).toEqual(Array(3).fill("Computational Thinking I"));
    expect(reversed.map((event) => ({ key: event.fachKey, dir: event.fachDir })))
      .toEqual(events.map((event) => ({ key: event.fachKey, dir: event.fachDir })));
    expect(renamed.fachKey).toBe(events[0].fachKey);
    expect(standalone.fachKey).toBe(events[0].fachKey);
  });

  it("keeps different courses within the same module and display name separate", () => {
    const events = parseIcs(calendar([
      { lv: "MCiT-26-M01-101-VO", name: "Coding", typ: "VO" },
      { lv: "MCiT-26-M01-101-UE", name: "Coding", typ: "UE" },
      { lv: "MCiT-26-M01-102-VO", name: "Coding", typ: "VO" },
      { lv: "MCiT-26-M01-102-UE", name: "Coding", typ: "UE" },
    ]));

    expect(events[0].fachKey).toBe(events[1].fachKey);
    expect(events[2].fachKey).toBe(events[3].fachKey);
    expect(events[0].fachKey).not.toBe(events[2].fachKey);
    expect(events[0].fachDir).not.toBe(events[2].fachDir);
    expect(buildFaecher(events).map((subject) => subject.termine)).toEqual([2, 2]);
  });

  it("normalizes LV casing, surrounding whitespace and Unicode composition", () => {
    const events = parseIcs(calendar([{ lv: "  ÄB-001  " }, { lv: "a\u0308b-001" }]));

    expect(events[1].fachKey).toBe(events[0].fachKey);
  });

  it("uses the normalized name without depending on type or teacher when LV is missing", () => {
    const original = parseIcs(calendar([{ name: " Einführung   in Datenbanken ", teacher: "Anna Example" }]))[0];
    const replacement = parseIcs(calendar([{ name: "EINFU\u0308HRUNG IN DATENBANKEN VO", typ: "VO", teacher: "Ben Example" }]))[0];
    const different = parseIcs(calendar([{ name: "Databases", teacher: "Anna Example" }]))[0];
    const together = parseIcs(calendar([
      { name: "Einführung in Datenbanken", teacher: "Anna Example" },
      { name: "Einführung in Datenbanken", teacher: "Ben Sample" },
    ]));

    expect(replacement.fachKey).toBe(original.fachKey);
    expect(different.fachKey).not.toBe(original.fachKey);
    expect(together.map((event) => event.fachKey)).toEqual([original.fachKey, original.fachKey]);
  });

  it("keeps LV identity separate from the name fallback", () => {
    const events = parseIcs(calendar([{ lv: "Databases" }, { name: "Databases" }]));

    expect(events[1].fachKey).not.toBe(events[0].fachKey);
  });

  it.each([
    ["AB/12", "AB-12"],
    ["AB_12", "AB-12"],
    ["AB.12", "AB12"],
    ["AB-001", "AB-1"],
    ["ÄB-12", "AEB-12"],
    ["AB-101", "AB-101-VO-extra"],
    ["AB-101", "AB-101-UE2"],
    ["AB-101", "AB-101VO"],
    ["AB-101", "AB-101_VO"],
    ["AB-101", "AB-UE-101"],
    [`${"A".repeat(300)}1`, `${"A".repeat(300)}2`],
  ])("does not merge distinct LV identifiers %s and %s", (first, second) => {
    const events = parseIcs(calendar([{ lv: first }, { lv: second }]));
    const standalone = parseIcs(calendar([{ lv: second }]))[0];

    expect(events[1].fachKey).not.toBe(events[0].fachKey);
    expect(standalone.fachKey).toBe(events[1].fachKey);
    expect(events[0].fachKey).toMatch(/^[a-z0-9-]{1,64}$/);
    expect(events[1].fachKey).toMatch(/^[a-z0-9-]{1,64}$/);
  });

  it.each([
    ["C++", "C#"],
    ["A/B", "A-B"],
    ["Überblick", "Ueberblick"],
    ["Coding", "CodingVO"],
    ["Coding", "Coding UE Advanced"],
    [`${"A".repeat(300)}1`, `${"A".repeat(300)}2`],
  ])("does not merge fallback names that share a folder slug: %s and %s", (first, second) => {
    const events = parseIcs(calendar([{ name: first }, { name: second }]));

    expect(events[1].fachKey).not.toBe(events[0].fachKey);
    expect(events[1].fachDir).not.toBe(events[0].fachDir);
    expect(events[0].fachKey).toMatch(/^[a-z0-9-]{1,64}$/);
    expect(events[1].fachKey).toMatch(/^[a-z0-9-]{1,64}$/);
  });
});

describe("parseIcs initial folder suggestions", () => {
  it("uses a readable subject slug and keeps the type only in event folders", () => {
    const events = parseIcs(calendar([{ lv: "DB-101", teacher: "Anna Example" }]));

    expect(events[0]).toMatchObject({
      fachDir: "01-databases",
      terminRel: "01-databases/2026-10-05_databases-ilv",
    });
  });

  it("keeps same-name subjects with different LVs in separate folders independent of feed order", () => {
    const variants = [{ lv: "DB-101" }, { lv: "DB-102" }];
    const events = parseIcs(calendar(variants));
    const reversed = parseIcs(calendar([...variants].reverse()));

    expect(new Set(events.map((event) => event.fachDir)).size).toBe(2);
    expect(events.map((event) => event.fachDir).sort()).toEqual(["01-databases", "02-databases"]);
    expect(reversed.map((event) => event.fachDir)).toEqual(events.map((event) => event.fachDir).reverse());
  });

  it("removes the type from the subject folder without duplicating it in the event folder", () => {
    const events = parseIcs(calendar([{ name: "Coding UE", typ: "UE" }]));

    expect(events[0]).toMatchObject({
      fachDir: "01-coding",
      terminRel: "01-coding/2026-10-05_coding-ue",
    });
  });

  it("keeps same-time events of different types in one subject folder", () => {
    const events = parseIcs(calendar([
      { name: "Coding", lv: "C-101-VO", typ: "VO" },
      { name: "Coding", lv: "C-101-UE", typ: "UE" },
    ]));

    expect(events.map((event) => event.terminRel)).toEqual([
      "01-coding/2026-10-05_coding-vo",
      "01-coding/2026-10-05_coding-ue",
    ]);
  });

  it("keeps same-time event folders distinct after teachers are grouped", () => {
    const events = parseIcs(calendar([
      { lv: "DB-101", teacher: "Anna Example" },
      { lv: "DB-101", teacher: "Ben Example" },
      { lv: "DB-101", teacher: "Chris Example" },
    ]));

    expect(events.map((event) => event.terminRel)).toEqual([
      "01-databases/2026-10-05_databases-ilv",
      "01-databases/2026-10-05_databases-ilv-0900",
      "01-databases/2026-10-05_databases-ilv-0900-2",
    ]);
  });
});

describe("buildFaecher", () => {
  it("combines sorted unique non-empty teachers and counts every event", () => {
    const events = parseIcs(calendar([
      { lv: "DB-101", teacher: "Ben Example" },
      { lv: "DB-101", teacher: "Anna Example" },
      { lv: "DB-101", teacher: "Anna Example" },
      { lv: "DB-101", teacher: "" },
    ]));

    expect(buildFaecher(events)).toEqual([{
      key: events[0].fachKey,
      name: "Databases",
      types: ["ILV"],
      dozent: "Anna Example, Ben Example",
      dir: "01-databases",
      file: undefined,
      termine: 4,
    }]);
    expect(buildFaecher([...events].reverse())).toEqual(buildFaecher(events));
  });

  it("collects every event type once in sorted order without changing individual event types", () => {
    const [event] = parseIcs(calendar([{ lv: "DB-101" }]));
    const types: EventType[] = ["VO", "SONST", "UE", "ILV", "VO"];
    const events = types.map((typ, index) => ({ ...event, uid: `event-${index}`, typ }));

    expect(buildFaecher(events)[0]).toMatchObject({ types: ["ILV", "SONST", "UE", "VO"], termine: 5 });
    expect(buildFaecher(events)[0]).not.toHaveProperty("typ");
    expect(buildFaecher([...events].reverse())).toEqual(buildFaecher(events));
    expect(events.map((entry) => entry.typ)).toEqual(types);
  });

  it("prefers canonical subjectDir over legacy event directories", () => {
    const [event] = parseIcs(calendar([{ lv: "DB-101" }]));
    const events = [
      { ...event, uid: "first", fachDir: "01-legacy-anna", subjectDir: "03-databases-ilv", subjectFile: "Databases.md" },
      { ...event, uid: "second", fachDir: "02-legacy-ben", subjectDir: "03-databases-ilv" },
      { ...event, uid: "third", fachDir: "01-legacy-anna" },
    ];

    expect(buildFaecher(events)[0]).toMatchObject({ dir: "03-databases-ilv", file: "Databases.md" });
    expect(buildFaecher([...events].reverse())).toEqual(buildFaecher(events));
  });

  it("keeps the subject filename paired with its directory when choosing a stable representative", () => {
    const [event] = parseIcs(calendar([{ lv: "DB-101" }]));
    const events = [
      { ...event, uid: "first", subjectDir: "03-databases-ilv", subjectFile: "First.md" },
      { ...event, uid: "second", subjectDir: "02-databases-ilv", subjectFile: "Second.md" },
    ];

    expect(buildFaecher(events)[0]).toMatchObject({ dir: "02-databases-ilv", file: "Second.md" });
    expect(buildFaecher([...events].reverse())).toEqual(buildFaecher(events));
  });

  it("selects a stable name and directory for legacy events regardless of input order", () => {
    const [event] = parseIcs(calendar([{ lv: "DB-101" }]));
    const events = [
      { ...event, uid: "first", fach: "Geleitetes Selbststudium Databases", fachDir: "02-legacy-ben" },
      { ...event, uid: "second", fach: "Databases", fachDir: "01-legacy-anna" },
    ];

    expect(buildFaecher(events)[0]).toMatchObject({ name: "Databases", dir: "01-legacy-anna", termine: 2 });
    expect(buildFaecher([...events].reverse())).toEqual(buildFaecher(events));
  });

  it("returns no subjects for an empty calendar", () => {
    expect(buildFaecher(parseIcs(calendar([])))).toEqual([]);
  });
});
