import { describe, expect, it } from "vitest";
import { parseSakaiPreferences, sakaiConfigKey } from "../src/lib/sakaiConfig";

describe("Sakai preferences", () => {
  it("has no implicit permission for automatic sync before setup", () => {
    expect(parseSakaiPreferences(null)).toBeNull();
  });
  it("keeps selections and paths scoped to the exact vault and semester", () => {
    expect(sakaiConfigKey("/Documents/MCIt /MCIt", "Sem01")).not.toBe(sakaiConfigKey("/Documents/MCIt/MCIt", "Sem01"));
    expect(sakaiConfigKey("/Documents/MCIt /MCIt", "Sem01")).not.toBe(sakaiConfigKey("/Documents/MCIt /MCIt", "Sem02"));
  });
  it("accepts explicit selections with a shared subject for UE and VO", () => {
    const value = { autoSync: true, selections: [{ siteId: "Course-UE", subjectKey: "coding" }, { siteId: "Course-VO", subjectKey: "coding" }, { siteId: "study", subjectKey: null }], lastSync: "2026-09-22T09:00:00Z" };
    expect(parseSakaiPreferences(JSON.stringify(value))).toEqual(value);
  });
  it.each(["", "{", "null", "[]", "{}", JSON.stringify({ autoSync: "true", selections: [], lastSync: null }),
    JSON.stringify({ autoSync: true, selections: [], lastSync: "never" }),
    JSON.stringify({ autoSync: true, selections: [{ siteId: "../outside", subjectKey: null }], lastSync: null }),
    JSON.stringify({ autoSync: true, selections: [{ siteId: "same", subjectKey: null }, { siteId: "same", subjectKey: "coding" }], lastSync: null }),
    JSON.stringify({ autoSync: true, selections: [null], lastSync: null }),
    JSON.stringify({ autoSync: true, selections: [{ siteId: "valid", subjectKey: 2 }], lastSync: null }),
  ])("rejects malformed settings rather than enabling sync: %s", (raw) => {
    expect(() => parseSakaiPreferences(raw)).toThrow();
  });
});
