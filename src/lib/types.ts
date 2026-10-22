export type EventType = "VO" | "UE" | "ILV" | "SONST";

export interface StudyEvent {
  uid: string;
  summary: string;
  /** Anzeigename des Fachs, z.B. "Databases" */
  fach: string;
  typ: EventType;
  dozent: string;
  lvNummer: string;
  /** stabiler Schlüssel, z.B. "databases-ilv" */
  fachKey: string;
  /** Ordnername des Fachs, z.B. "01-databases-ilv_bernsteiner" */
  fachDir: string;
  start: string; // ISO
  end: string; // ISO
  /** Pfad des Termin-Ordners relativ zu Sem01, z.B. "01-databases-ilv_bernsteiner/2026-10-05_databases-ilv" */
  terminRel: string;
  noteFile?: string;
  subjectDir?: string;
  subjectFile?: string;
}

export interface FachInfo {
  key: string;
  name: string;
  types: EventType[];
  dozent: string;
  dir: string;
  termine: number;
  file?: string;
}

export interface TerminMeta {
  uid: string;
  summary: string;
  start: string;
  end: string;
  fachKey: string;
  vorbereitet: boolean;
  nachbereitet: boolean;
  abgesagt?: boolean;
  updatedAt: string;
}

export interface AppConfig {
  icalUrl: string;
  basisPfad: string;
  /** Semester-Label, z.B. "Sem01-MCiT26-IM" */
  semester: string;
  refreshHours: number;
  lastRefresh: string | null;
}

export const DEFAULT_CONFIG: AppConfig = {
  icalUrl: "",
  basisPfad: "",
  semester: "Sem01-MCiT26-IM",
  refreshHours: 12,
  lastRefresh: null,
};
