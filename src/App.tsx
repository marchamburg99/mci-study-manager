import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { StudyEvent } from "./lib/types";
import { buildFaecher } from "./lib/ical";
import { buildDemoEvents } from "./lib/demo";
import { useStudyCalendar } from "./hooks/useStudyCalendar";
import { useKnowledge } from "./hooks/useKnowledge";
import { useSakai } from "./hooks/useSakai";
import { Settings } from "./components/Settings";
import { SetupWizard } from "./components/SetupWizard";
import { configContextKey } from "./lib/config";
import { getFokus, eventsAmTag, formatZeit, formatTag } from "./lib/focus";
import { fachHue } from "./lib/hue";
import { FachView } from "./components/FachView";
import { Kalender } from "./components/Kalender";
import { Vorbereiten } from "./components/Vorbereiten";
import { KnowledgeView } from "./components/KnowledgeView";
import { KnowledgeHighlights, SubjectKnowledge } from "./components/KnowledgeHighlights";
import {
  IconToday,
  IconCal,
  IconCheck,
  IconGrid,
  IconSearch,
  IconSync,
  IconChevron,
  IconFlask,
  IconClock,
  IconSettings,
  IconDoc,
} from "./components/icons";
import "./App.css";

type View =
  | { name: "heute" }
  | { name: "vorbereiten" }
  | { name: "kalender" }
  | { name: "fach"; uid: string; snapshot?: StudyEvent; context?: string; knowledgeOrigin?: { path?: string; context?: string; history: { view: View; context: string | undefined }[] } }
  | { name: "wissen"; path?: string; context?: string }
  | { name: "alle" };

const DEMO_LS = "mci-manager-demo-anchor";

function formatRel(iso: string | null): string {
  if (!iso) return "noch nie";
  const min = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  if (min < 1) return "gerade eben";
  if (min < 60) return `vor ${min} Min.`;
  const h = Math.round(min / 60);
  if (h < 24) return `vor ${h} Std.`;
  return new Date(iso).toLocaleDateString("de-AT", { day: "2-digit", month: "2-digit" });
}

function formatLang(iso: string): string {
  return new Date(iso).toLocaleDateString("de-AT", {
    weekday: "long",
    day: "numeric",
    month: "long",
  });
}

export default function App() {
  const unsafeDraft = useRef(false);
  const canSync = useCallback(() => !unsafeDraft.current, []);
  const { cfg, events, syncing, ready, desktop, error, state, refreshNow, applyConfig } = useStudyCalendar(canSync);
  const knowledge = useKnowledge(cfg, events, ready && desktop);
  const sakai = useSakai(cfg, events, knowledge.notes, ready && desktop, knowledge.reload, !knowledge.loading);
  const [view, changeView] = useState<View>({ name: "heute" });
  const knowledgeHistory = useRef<{ view: View; context: string | undefined }[]>([]);
  const onPendingChange = useCallback((pending: boolean) => { unsafeDraft.current = pending; }, []);
  const canLeave = useCallback(() => {
    if (!unsafeDraft.current) return true;
    window.alert("Deine letzten Änderungen konnten nicht als Entwurf gesichert werden. Bitte zuerst die Notiz speichern oder den Text kopieren, bevor du die Ansicht wechselst.");
    return false;
  }, []);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [query, setQuery] = useState("");
  const [subjectKey, setSubjectKey] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [demoAnchor, setDemoAnchor] = useState<number | null>(() => {
    try {
      const raw = localStorage.getItem(DEMO_LS);
      const n = raw ? Number(raw) : NaN;
      return Number.isFinite(n) && n > 0 ? n : null;
    } catch {
      return null;
    }
  });

  const [setupOpen, setSetupOpen] = useState(false);
  // First launch: without a personal calendar link nothing can sync, so guide straight into setup.
  const setupPrompted = useRef(false);
  useEffect(() => {
    if (!desktop || !cfg || cfg.icalUrl || setupPrompted.current) return;
    setupPrompted.current = true;
    setSetupOpen(true);
  }, [desktop, cfg]);

  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);

  const toggleDemo = useCallback(() => {
    if (!canLeave()) return;
    setDemoAnchor((prev) => {
      const next = prev ? null : Date.now();
      try {
        if (next) localStorage.setItem(DEMO_LS, String(next));
        else localStorage.removeItem(DEMO_LS);
      } catch {
        // Demo mode can remain session-local when browser storage is unavailable.
      }
      return next;
    });
  }, [canLeave]);

  const openSettings = () => {
    if (!cfg || !canLeave()) return;
    setSettingsOpen(true);
  };

  const demoEvents = useMemo(
    () => (demoAnchor ? buildDemoEvents(demoAnchor) : []),
    [demoAnchor],
  );
  const allEvents = useMemo(() => [...events, ...demoEvents], [events, demoEvents]);

  const fokus = useMemo(() => getFokus(allEvents, nowMs), [allEvents, nowMs]);
  const heute = useMemo(() => eventsAmTag(allEvents, nowMs), [allEvents, nowMs]);
  const faecher = useMemo(() => buildFaecher(allEvents), [allEvents]);

  const selected: StudyEvent | null = useMemo(() => {
    if (view.name !== "fach") return null;
    return allEvents.find((e) => e.uid === view.uid)
      ?? (cfg && view.context === configContextKey(cfg) ? view.snapshot ?? null : null);
  }, [view, allEvents, cfg]);

  let knowledgeSubjectKey: string | null = null;
  if (view.name === "fach" && selected) knowledgeSubjectKey = selected.fachKey;
  if (view.name === "alle") knowledgeSubjectKey = subjectKey;
  const openedEventUid = view.name === "fach" ? view.uid : null;
  const refreshSubject = sakai.refreshSubject;
  useEffect(() => {
    if (ready && desktop && knowledgeSubjectKey) void refreshSubject(knowledgeSubjectKey);
  }, [desktop, knowledgeSubjectKey, openedEventUid, ready, refreshSubject, view.name]);

  const gefiltert = useMemo(() => {
    if (subjectKey) return allEvents.filter((e) => e.fachKey === subjectKey);
    const q = query.trim().toLowerCase();
    if (!q) return allEvents;
    return allEvents.filter((e) =>
      `${e.fach} ${e.dozent} ${e.summary}`.toLowerCase().includes(q),
    );
  }, [allEvents, query, subjectKey]);

  const setView = (next: View) => {
    if (!canLeave()) return;
    if (next.name === "fach") {
      const context = cfg ? configContextKey(cfg) : undefined;
      let knowledgeOrigin: Extract<View, { name: "fach" }>["knowledgeOrigin"];
      if (view.name === "wissen" && view.context === context) knowledgeOrigin = { path: view.path, context, history: [...knowledgeHistory.current] };
      else if (view.name === "fach" && view.context === context) knowledgeOrigin = view.knowledgeOrigin;
      changeView({ ...next, snapshot: allEvents.find((event) => event.uid === next.uid), context, knowledgeOrigin });
    } else if (next.name === "wissen") {
      const context = cfg ? configContextKey(cfg) : undefined;
      if (view.name !== "wissen" || view.context !== context) knowledgeHistory.current = [];
      if (view.name !== "wissen" || (view.context === context && view.path !== next.path)) {
        knowledgeHistory.current.push({ view, context });
      }
      changeView({ ...next, context });
    } else changeView(next);
  };

  const handleKnowledgeBack = () => {
    if (!canLeave()) return;
    const previous = knowledgeHistory.current.pop();
    const context = cfg ? configContextKey(cfg) : undefined;
    if (!previous || previous.context !== context) {
      knowledgeHistory.current = [];
      changeView({ name: "heute" });
      return;
    }
    changeView(previous.view);
  };

  const goFach = (key: string, fachName: string) => {
    if (!canLeave()) return;
    setSubjectKey(key);
    setQuery(fachName);
    setView({ name: "alle" });
  };

  const handleEventBack = () => {
    if (!canLeave()) return;
    const origin = view.name === "fach" ? view.knowledgeOrigin : undefined;
    const context = cfg ? configContextKey(cfg) : undefined;
    if (origin && origin.context === context) {
      knowledgeHistory.current = [...origin.history];
      changeView({ name: "wissen", path: origin.path, context });
    } else setView({ name: "heute" });
  };

  const aktiv: "heute" | "vorbereiten" | "kalender" | "fach" | "alle" | "wissen" =
    view.name === "fach" ? "fach" : view.name;

  if (!cfg) {
    return (
      <div className="app boot">
        <div className="boot-card">
          <span className="spin" aria-hidden="true" />
          <p>Studien-Manager startet …</p>
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <header className="toolbar" data-tauri-drag-region>
        <div className="traffic" aria-hidden="true" />
        <div className="segmented" role="tablist" aria-label="Hauptnavigation">
          <button
            role="tab"
            aria-selected={aktiv === "heute"}
            className={aktiv === "heute" ? "on" : ""}
            onClick={() => setView({ name: "heute" })}
          >
            <IconToday size={15} />
            Heute
          </button>
          <button
            role="tab"
            aria-selected={aktiv === "vorbereiten"}
            className={aktiv === "vorbereiten" ? "on" : ""}
            onClick={() => setView({ name: "vorbereiten" })}
          >
            <IconCheck size={15} />
            Vorbereiten
          </button>
          <button
            role="tab"
            aria-selected={aktiv === "kalender"}
            className={aktiv === "kalender" ? "on" : ""}
            onClick={() => setView({ name: "kalender" })}
          >
            <IconCal size={15} />
            Kalender
          </button>
          <button
            role="tab"
            aria-selected={aktiv === "alle" || aktiv === "fach"}
            className={aktiv === "alle" || aktiv === "fach" ? "on" : ""}
            onClick={() => setView({ name: "alle" })}
          >
            <IconGrid size={15} />
            Übersicht
          </button>
          <button
            role="tab"
            aria-selected={aktiv === "wissen"}
            className={aktiv === "wissen" ? "on" : ""}
            onClick={() => setView({ name: "wissen" })}
          >
            <IconDoc size={15} />
            Studienwissen
          </button>
        </div>
        <div className="toolbar-actions">
          <button
            className={`iconbtn ${syncing ? "busy" : ""}`}
            title="Stundenplan synchronisieren"
            onClick={() => void refreshNow()}
            disabled={syncing || !ready}
          >
            <IconSync size={17} />
          </button>
          <button
            className={`iconbtn ${demoAnchor ? "on" : ""}`}
            title="Demo-Modus: Fach für heute simulieren"
            onClick={toggleDemo}
          >
            <IconFlask size={17} />
          </button>
        </div>
      </header>

      <div className="body">
        <aside className="sidebar">
          <div className="sidebar-brand">
            <IconDoc size={20} />
            <div><strong>Studien-Manager</strong><span>Dein Studium im Blick</span></div>
          </div>
          <label className="spotlight">
            <IconSearch size={15} />
            <input
              aria-label="Fächer und Termine suchen"
              placeholder="Suchen"
              value={query}
              onChange={(e) => {
                setSubjectKey(null);
                setQuery(e.target.value);
                if (view.name !== "alle") setView({ name: "alle" });
              }}
            />
            {query && (
              <button className="clear" onClick={() => { setQuery(""); setSubjectKey(null); }} aria-label="Suche löschen">
                ×
              </button>
            )}
          </label>

          <p className="side-label">Fächer</p>
          <ul className="side-list">
            {faecher.map((f) => (
              <li key={f.key}>
                <button onClick={() => goFach(f.key, f.name)} title={`${f.name} · ${f.types.join(", ")} · ${f.dozent}`}
                  aria-current={(view.name === "alle" && subjectKey === f.key) || (view.name === "fach" && selected?.fachKey === f.key) ? "page" : undefined}>
                  <span
                    className="dot"
                    style={{ background: `hsl(${fachHue(f.key)} 70% 50%)` }}
                  />
                  <span className="side-name">{f.name}</span>
                  <span className="count">{f.termine}</span>
                </button>
              </li>
            ))}
            {faecher.length === 0 && (
              <li className="side-empty">Noch keine Fächer — synchronisieren.</li>
            )}
          </ul>

          <div className="side-foot">
            <div className="syncrow">
              <span className={`pulse ${syncing ? "busy" : ""}`} />
              <span>{!desktop ? "Browser-Vorschau" : syncing ? "Synchronisiere …" : state === "offline" ? `Offline · Stand ${formatRel(cfg.lastRefresh)}` : `Sync ${formatRel(cfg.lastRefresh)}`}</span>
            </div>
            {demoAnchor && (
              <button className="demo-note" onClick={toggleDemo} title="Demo-Modus beenden">
                <IconFlask size={14} />
                Demo aktiv — beenden
              </button>
            )}
            <button className="path settings-trigger" onClick={openSettings} title="Einstellungen öffnen">
              <IconSettings size={13} />
              <span>{cfg.semester}</span>
            </button>
          </div>
        </aside>

        <main className="content" key={view.name}>
          {error && <p className="banner-error">{error}</p>}
          {!desktop && <p className="banner-info">Browser-Vorschau: Kalender und Demo sind verfügbar. Notizen, Dateien und Synchronisation benötigen die Desktop-App.</p>}

          {view.name === "heute" && (
            <>
              <h1 className="title">Heute</h1>
              <p className="subtitle">{formatLang(new Date(nowMs).toISOString())}</p>

              {fokus.laufend ? (
                <section
                  className="hero"
                  onClick={() => setView({ name: "fach", uid: fokus.laufend!.uid })}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === "Enter")
                      setView({ name: "fach", uid: fokus.laufend!.uid });
                  }}
                >
                  <span className="pill live">
                    <span className="livedot" />
                    Jetzt · bis {formatZeit(fokus.laufend.end)}
                  </span>
                  <h2>{fokus.laufend.fach}</h2>
                  <p>
                    {fokus.laufend.typ} · {fokus.laufend.dozent}
                  </p>
                  <span className="hero-cta">
                    Fachfenster öffnen <IconChevron size={14} />
                  </span>
                </section>
              ) : fokus.naechstes ? (
                <section
                  className="hero next"
                  onClick={() => setView({ name: "fach", uid: fokus.naechstes!.uid })}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === "Enter")
                      setView({ name: "fach", uid: fokus.naechstes!.uid });
                  }}
                >
                  {fokus.bald && <span className="pill soon">Gleich geht's los</span>}
                  <h2>{fokus.naechstes.fach}</h2>
                  <p>
                    {formatTag(fokus.naechstes.start)}, {formatZeit(fokus.naechstes.start)} ·{" "}
                    {fokus.naechstes.typ} · {fokus.naechstes.dozent}
                  </p>
                  <span className="hero-cta">
                    Vorbereiten <IconChevron size={14} />
                  </span>
                </section>
              ) : (
                <section className="hero calm">
                  <span className="pill">Kein Termin mehr</span>
                  <h2>Für heute geschafft.</h2>
                  <p>Nutze die Zeit für Nachbereitung.</p>
                </section>
              )}

              {ready && desktop && <KnowledgeHighlights notes={knowledge.notes} nowMs={nowMs} semester={cfg.semester} loading={knowledge.loading} warnings={knowledge.warnings}
                onOpen={(path) => setView({ name: "wissen", path })} onShowAll={() => setView({ name: "wissen" })} />}

              <h3 className="section">Zeitplan</h3>
              {heute.length === 0 ? (
                <div className="empty">
                  <IconClock size={28} />
                  <p>Heute steht nichts an.</p>
                </div>
              ) : (
                <ol className="timeline">
                  {heute.map((e, i) => {
                    const live = fokus.laufend?.uid === e.uid;
                    const past = Date.parse(e.end) <= nowMs;
                    return (
                      <li
                        key={e.uid}
                        className={live ? "live" : past ? "past" : ""}
                        style={{ "--i": i } as React.CSSProperties}
                      >
                        <div className="t-gutter">
                          <span className="t-time">{formatZeit(e.start)}</span>
                          <span className="t-rail">
                            <span className="t-dot" />
                            {i < heute.length - 1 && <span className="t-line" />}
                          </span>
                        </div>
                        <button
                          className="t-card"
                          onClick={() => setView({ name: "fach", uid: e.uid })}
                        >
                          <span
                            className="t-stripe"
                            style={{ background: `hsl(${fachHue(e.fachKey)} 70% 50%)` }}
                          />
                          <span className="t-main">
                            <strong>
                              {e.fach} <span className="ttyp">{e.typ}</span>
                            </strong>
                            <span className="t-meta">
                              {formatZeit(e.start)} – {formatZeit(e.end)} · {e.dozent}
                            </span>
                          </span>
                          {live ? (
                            <span className="pill live sm">Jetzt</span>
                          ) : (
                            <IconChevron size={15} />
                          )}
                        </button>
                      </li>
                    );
                  })}
                </ol>
              )}

              <h3 className="section">Fächer</h3>
              <div className="grouped">
                {faecher.map((f) => (
                  <button key={f.key} className="row" onClick={() => goFach(f.key, f.name)}>
                    <span
                      className="dot lg"
                      style={{ background: `hsl(${fachHue(f.key)} 70% 50%)` }}
                    />
                    <span className="row-main">
                      <strong>{f.name}</strong>
                      <span className="row-sub">
                        {f.termine} Termine · {f.dozent}
                      </span>
                    </span>
                    <IconChevron size={15} />
                  </button>
                ))}
              </div>
            </>
          )}

          {view.name === "vorbereiten" && ready && (
            <Vorbereiten
              cfg={cfg}
              events={allEvents}
              nowMs={nowMs}
              onOpen={(uid) => setView({ name: "fach", uid })}
              key={JSON.stringify([cfg.basisPfad, cfg.semester])}
            />
          )}

          {view.name === "kalender" && (
            <Kalender
              events={allEvents}
              nowMs={nowMs}
              onOpen={(uid) => setView({ name: "fach", uid })}
            />
          )}

          {view.name === "fach" && selected && ready && (
            <>
            {!allEvents.some((event) => event.uid === selected.uid) && <p className="banner-info">Dieser Termin steht nicht mehr im aktuellen Kalender. Die geöffnete Notiz bleibt bis zum Verlassen dieser Ansicht verfügbar.</p>}
            <FachView
              key={JSON.stringify([cfg.basisPfad, cfg.semester, selected.terminRel, selected.uid])}
              cfg={cfg}
              event={selected}
              events={allEvents}
              hue={fachHue(selected.fachKey)}
              knowledge={<SubjectKnowledge cfg={cfg} sakai={sakai} notes={knowledge.notes} subjectKey={selected.fachKey} onOpen={(path) => setView({ name: "wissen", path })} />}
              knowledgeNotes={knowledge.notes}
              onOpenKnowledge={(path) => setView({ name: "wissen", path })}
              onOpenSubject={goFach}
              onPendingChange={onPendingChange}
              onBack={handleEventBack}
              backLabel={view.knowledgeOrigin?.context === configContextKey(cfg) ? "Zurück" : "Heute"}
              onOpen={(uid) => setView({ name: "fach", uid })}
            />
            </>
          )}
          {view.name === "wissen" && ready && desktop && <KnowledgeView
            sakai={sakai} events={events}
            key={JSON.stringify([cfg.basisPfad, cfg.semester])}
            cfg={cfg} notes={knowledge.notes} warnings={knowledge.warnings} loading={knowledge.loading}
            selectedPath={view.context === configContextKey(cfg) ? view.path : undefined}
            onBack={handleKnowledgeBack}
            onOpenSubject={goFach} onOpenEvent={(uid) => setView({ name: "fach", uid })}
            onReload={knowledge.reload} onSelect={(path) => setView({ name: "wissen", path })} onShowAll={() => setView({ name: "wissen" })}
          />}
          {view.name === "wissen" && (!ready || !desktop) && <div className="empty"><p>{desktop ? "Bitte zuerst einen gültigen Vault auswählen." : "Studienwissen liest deine lokalen Obsidian-Notizen. Öffne dafür die Desktop-App."}</p></div>}
          {(view.name === "fach" || view.name === "vorbereiten") && !ready && (
            <div className="empty"><p>{desktop ? "Bitte zuerst einen gültigen Vault in den Einstellungen auswählen." : "Öffne die Desktop-App, um Notizen und Vorbereitung zu bearbeiten."}</p></div>
          )}
          {view.name === "fach" && !selected && (
            <div className="empty">
              <p>Termin nicht gefunden — der Plan hat sich vermutlich geändert.</p>
              <button className="primary" onClick={() => setView({ name: "heute" })}>
                Zurück zu Heute
              </button>
            </div>
          )}

          {view.name === "alle" && (
            <>
              <h1 className="title">{subjectKey ? faecher.find((fach) => fach.key === subjectKey)?.name ?? query : "Übersicht"}</h1>
              <p className="subtitle">
                {gefiltert.length} {gefiltert.length === 1 ? "Termin" : "Termine"}
                {query.trim() && (
                  <>
                    {" "}für „{query.trim()}“{" "}
                    <button className="chip-clear" onClick={() => { setQuery(""); setSubjectKey(null); }}>
                      Zurücksetzen
                    </button>
                  </>
                )}
              </p>
              {subjectKey && <SubjectKnowledge cfg={cfg} sakai={sakai} notes={knowledge.notes} subjectKey={subjectKey} onOpen={(path) => setView({ name: "wissen", path })} />}
              {subjectKey && <h3 className="section">Einheiten & Notizen</h3>}
              <div className="grouped">
                {gefiltert.slice(0, 200).map((e) => {
                  const d = new Date(e.start);
                  return (
                    <button
                      key={e.uid}
                      className="row"
                      onClick={() => setView({ name: "fach", uid: e.uid })}
                    >
                      <span className="datebadge">
                        <span className="db-day">
                          {d.toLocaleDateString("de-AT", { day: "2-digit" })}
                        </span>
                        <span className="db-wd">
                          {d.toLocaleDateString("de-AT", { weekday: "short" })}
                        </span>
                      </span>
                      <span className="row-main">
                        <strong>
                          {e.fach} <span className="ttyp">{e.typ}</span>
                        </strong>
                        <span className="row-sub">
                          {formatTag(e.start)}, {formatZeit(e.start)} · {e.dozent}
                        </span>
                      </span>
                      <IconChevron size={15} />
                    </button>
                  );
                })}
                {gefiltert.length === 0 && (
                  <div className="empty">
                    <IconSearch size={28} />
                    <p>Nichts gefunden.</p>
                  </div>
                )}
              </div>
            </>
          )}
        </main>
      </div>
      {settingsOpen && (
        <Settings
          cfg={cfg}
          disabled={!desktop || syncing}
          onClose={() => setSettingsOpen(false)}
          onSave={applyConfig}
          onOpenSetup={() => { setSettingsOpen(false); setSetupOpen(true); }}
        />
      )}
      {setupOpen && cfg && (
        <SetupWizard cfg={cfg} disabled={!desktop || syncing} onClose={() => setSetupOpen(false)} onSave={applyConfig} />
      )}
    </div>
  );
}
