import { useEffect, useMemo, useState } from "react";
import type { AppConfig, StudyEvent } from "../lib/types";
import type { KnowledgeCatalog } from "../lib/knowledge";
import { loadKnowledge } from "../lib/knowledgeStorage";

const EMPTY: KnowledgeCatalog = { notes: [], warnings: [] };

export function useKnowledge(cfg: AppConfig | null, events: StudyEvent[], enabled: boolean) {
  const basisPfad = cfg?.basisPfad ?? "";
  const semester = cfg?.semester ?? "";
  const context = JSON.stringify([basisPfad, semester]);
  const config = useMemo(() => ({ basisPfad, semester }), [basisPfad, semester]);
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<{ context: string; catalog: KnowledgeCatalog; loading: boolean }>({ context: "", catalog: EMPTY, loading: false });

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    let reading = false;
    const read = async () => {
      if (reading) return;
      reading = true;
      setState((previous) => ({ context, catalog: previous.context === context ? previous.catalog : EMPTY, loading: true }));
      let catalog: KnowledgeCatalog;
      try { catalog = await loadKnowledge(config, events); }
      catch { catalog = { notes: [], warnings: ["Studienwissen konnte nicht geladen werden. Bitte Vault und Semester prüfen."] }; }
      if (alive) setState({ context, catalog, loading: false });
      reading = false;
    };
    void read();
    const focus = () => void read();
    const timer = window.setInterval(focus, 30_000);
    window.addEventListener("focus", focus);
    return () => { alive = false; window.clearInterval(timer); window.removeEventListener("focus", focus); };
  }, [config, context, enabled, events, revision]);

  const current = enabled && state.context === context;
  return {
    notes: current ? state.catalog.notes : EMPTY.notes,
    warnings: current ? state.catalog.warnings : EMPTY.warnings,
    loading: enabled && (!current || state.loading),
    reload: () => setRevision((value) => value + 1),
  };
}
