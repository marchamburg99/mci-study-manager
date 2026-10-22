import type { StudyEvent } from "./types";

const DEMO_FACH = "Demo-Fach";
const DEMO_DIR = "00-demo-fach_test";

function localDateKey(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

/**
 * Demo-Modus: zwei Termine relativ zum Einschaltzeitpunkt, damit das
 * Fachfenster auch vor Semesterstart (30.09.) testbar ist.
 * Ordner landen bewusst unter 00-demo-fach_test/ und können danach
 * einfach aus ~/MCI gelöscht werden.
 */
export function buildDemoEvents(anchorMs: number): StudyEvent[] {
  const now = new Date(anchorMs);
  const start1 = new Date(anchorMs - 30 * 60_000);
  const end1 = new Date(anchorMs + 60 * 60_000);
  const start2 = new Date(anchorMs + 3 * 60 * 60_000);
  const end2 = new Date(anchorMs + 4.5 * 60 * 60_000);
  const dateKey = localDateKey(now);
  const base = {
    fach: DEMO_FACH,
    typ: "ILV" as const,
    dozent: "Test Dozent",
    lvNummer: "DEMO-001",
    fachKey: "demo-fach-test",
    fachDir: DEMO_DIR,
  };
  return [
    {
      ...base,
      uid: "demo-event-jetzt",
      summary: `${DEMO_FACH} (ILV) - Demo (Test Dozent)`,
      start: start1.toISOString(),
      end: end1.toISOString(),
      terminRel: `${DEMO_DIR}/${dateKey}_demo-fach-test`,
    },
    {
      ...base,
      uid: "demo-event-spaeter",
      summary: `${DEMO_FACH} (ILV) - Demo Nachmittag (Test Dozent)`,
      start: start2.toISOString(),
      end: end2.toISOString(),
      terminRel: `${DEMO_DIR}/${dateKey}_demo-fach-test-2`,
    },
  ];
}
