import { useEffect, useMemo, useState } from "react";
import type { AppConfig, StudyEvent } from "../lib/types";
import {
  dayKey,
  formatTag,
  formatZeit,
  relDayLabel,
} from "../lib/focus";
import { fachHue } from "../lib/hue";
import { peekStatus } from "../lib/storage";
import { errorMessage } from "../lib/config";
import { preparationGroups, unfinishedEvents, type PreparationStatus as Status } from "../lib/preparation";
import { IconCheck, IconChevron } from "./icons";

function PrepPill({ s }: { s: Status | undefined }) {
  if (!s) return <span className="pill">…</span>;
  if (s.vorbereitet)
    return (
      <span className="pill ok">
        <IconCheck size={12} /> Bereit
      </span>
    );
  return <span className="pill soon">Offen</span>;
}

function PrepRow({
  e,
  status,
  pill,
  onOpen,
}: {
  e: StudyEvent;
  status: Status | undefined;
  pill: React.ReactNode;
  onOpen: (uid: string) => void;
}) {
  return (
    <button key={e.uid} className="row" onClick={() => onOpen(e.uid)}>
      <span
        className="dot lg"
        style={{ background: `hsl(${fachHue(e.fachKey)} 70% 50%)` }}
      />
      <span className="row-main">
        <strong>
          {e.fach} <span className="ttyp">{e.typ}</span>
        </strong>
        <span className="row-sub">
          {formatZeit(e.start)} – {formatZeit(e.end)} · {e.dozent}
        </span>
      </span>
      {status === undefined ? <span className="pill">…</span> : pill}
      <IconChevron size={15} />
    </button>
  );
}

export function Vorbereiten({
  cfg,
  events,
  nowMs,
  onOpen,
}: {
  cfg: AppConfig;
  events: StudyEvent[];
  nowMs: number;
  onOpen: (uid: string) => void;
}) {
  const [map, setMap] = useState<Record<string, Status>>({});
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const upcoming = useMemo(() => preparationGroups(events, nowMs), [events, nowMs]);
  const relevant = useMemo(() => {
    const upcomingIds = new Set(upcoming.flatMap((group) => group.list.map((event) => event.uid)));
    return events.filter((event) => Date.parse(event.end) <= nowMs || upcomingIds.has(event.uid));
  }, [events, nowMs, upcoming]);

  // Status aller relevanten Notizen lesen (ohne Ordner anzulegen).
  useEffect(() => {
    let alive = true;
    let reading = false;
    const read = async () => {
      if (reading) return;
      reading = true;
      const entries: [string, Status][] = [];
      const failures: string[] = [];
      // Bound concurrent filesystem reads for semester-sized calendars.
      for (let offset = 0; alive && offset < relevant.length; offset += 12) {
        await Promise.all(relevant.slice(offset, offset + 12).map(async (event) => {
          try { entries.push([event.uid, await peekStatus(cfg, event.terminRel)]); }
          catch (cause) { failures.push(errorMessage(cause)); }
        }));
      }
      if (alive) {
        setMap(Object.fromEntries(entries));
        setError(failures.length ? `${failures.length} Notizen nicht lesbar. Ihr Status bleibt unbekannt: ${failures[0]}` : null);
        setLoading(false);
      }
      reading = false;
    };
    void read();
    const timer = window.setInterval(() => void read(), 15_000);
    const focus = () => void read();
    window.addEventListener("focus", focus);
    return () => {
      alive = false;
      window.clearInterval(timer);
      window.removeEventListener("focus", focus);
    };
  }, [cfg, relevant]);

  const pastOpen = useMemo(
    () => unfinishedEvents(events, map, nowMs),
    [events, map, nowMs],
  );
  const ready = upcoming.flatMap((g) => g.list).filter((e) => map[e.uid]?.vorbereitet).length;
  const total = upcoming.flatMap((g) => g.list).length;
  const known = upcoming.flatMap((g) => g.list).filter((e) => map[e.uid] !== undefined).length;

  return (
    <>
      <h1 className="title">Vorbereiten</h1>
      <p className="subtitle">
        Heute + nächste 7 Tage · {ready} von {total} bereit
      </p>
      {error && <p className="banner-error" role="alert">{error}</p>}
      {loading && <p className="prep-hint">Notizstatus wird geladen …</p>}

      <div className="progress">
        <div className="progress-track">
          <div
            className="progress-fill"
            style={{ width: total ? `${(ready / total) * 100}%` : "0%" }}
          />
        </div>
        <span>{total === 0 ? "Nichts anstehend" : known < total ? "Status teilweise unbekannt" : ready === total ? "Alles bereit" : "Noch offen"}</span>
      </div>

      {pastOpen.length > 0 && (
        <>
          <h3 className="section">
            Liegengeblieben <span className="count">{pastOpen.length}</span>
          </h3>
          <p className="prep-hint">Gewesen, aber nicht nachbereitet — holt dich sonst in der Prüfung ein.</p>
          <div className="grouped">
            {pastOpen.map((e) => (
              <PrepRow
                key={e.uid}
                e={e}
                status={map[e.uid]}
                pill={<span className="pill soon">Nachholen</span>}
                onOpen={onOpen}
              />
            ))}
          </div>
        </>
      )}

      {!loading && !error && upcoming.length === 0 && pastOpen.length === 0 && (
        <div className="empty">
          <IconCheck size={28} />
          <p>Nächste 7 Tage frei. Zeit für Nachbereitung oder Pause.</p>
        </div>
      )}

      {upcoming.map(({ ms, list }) => (
        <div key={dayKey(ms)}>
          <h3 className="section">
            {relDayLabel(ms, nowMs)} <span className="row-sub">· {formatTag(new Date(ms).toISOString())}</span>
          </h3>
          <div className="grouped">
            {list.map((e) => (
              <PrepRow key={e.uid} e={e} status={map[e.uid]} pill={<PrepPill s={map[e.uid]} />} onOpen={onOpen} />
            ))}
          </div>
        </div>
      ))}
    </>
  );
}
