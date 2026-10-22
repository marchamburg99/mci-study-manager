import { useEffect, useMemo, useState } from "react";
import type { StudyEvent } from "../lib/types";
import { dayKey, formatZeit } from "../lib/focus";
import { monthCells } from "./Kalender";
import { IconBack, IconChevron } from "./icons";

const DOW = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];

// Kompakter Monats-Kalender für die Fach-Seitenleiste: zeigt NUR die Termine
// dieses Fachs (Punkte in Fach-Farbe), Klick auf einen Tag wechselt direkt
// dorthin. Kein separates Anlegen — Anlegen bleibt der Fachansicht vorbehalten.

export function FachKalender({
  events,
  currentUid,
  hue,
  onOpen,
}: {
  events: StudyEvent[];
  currentUid: string;
  hue: number;
  onOpen: (uid: string) => void;
}) {
  const cur = events.find((e) => e.uid === currentUid) ?? events[0] ?? null;

  const [nowMs, setNowMs] = useState(() => Date.now());
  const [initD] = useState(() => {
    const ms = cur ? Date.parse(cur.start) : nowMs;
    return new Date(Number.isFinite(ms) ? ms : nowMs);
  });
  const [ym, setYm] = useState(() => ({ y: initD.getFullYear(), m: initD.getMonth() }));
  const [sel, setSel] = useState<string>(() => dayKey(initD.getTime()));
  const todayKey = dayKey(nowMs);
  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const byDay = useMemo(() => {
    const map = new Map<string, StudyEvent[]>();
    for (const e of events) {
      const k = dayKey(Date.parse(e.start));
      if (!map.has(k)) map.set(k, []);
      map.get(k)!.push(e);
    }
    for (const list of map.values()) list.sort((a, b) => a.start.localeCompare(b.start));
    return map;
  }, [events]);

  const cells = useMemo(() => monthCells(ym.y, ym.m), [ym]);
  const monthLabel = new Date(ym.y, ym.m, 1).toLocaleDateString("de-AT", {
    month: "long",
    year: "numeric",
  });

  const goMonth = (d: number) => {
    const n = new Date(ym.y, ym.m + d, 1);
    setYm({ y: n.getFullYear(), m: n.getMonth() });
  };
  const goCurrent = () => {
    if (!cur) return;
    const d = new Date(Date.parse(cur.start));
    setYm({ y: d.getFullYear(), m: d.getMonth() });
    setSel(dayKey(Date.parse(cur.start)));
  };

  const clickDay = (k: string) => {
    const list = byDay.get(k) ?? [];
    if (list.length === 1) {
      onOpen(list[0].uid);
      return;
    }
    setSel(k);
  };

  const dayList = byDay.get(sel) ?? [];
  const selLabel = new Date(`${sel}T12:00:00`).toLocaleDateString("de-AT", {
    weekday: "short",
    day: "2-digit",
    month: "2-digit",
  });

  return (
    <>
      <div className="cal-mini-head">
        <button className="iconbtn sm" title="Voriger Monat" onClick={() => goMonth(-1)}>
          <IconBack size={14} />
        </button>
        <button className="cal-mini-title" title="Zum aktuellen Termin springen" onClick={goCurrent}>
          {monthLabel}
        </button>
        <button className="iconbtn sm" title="Nächster Monat" onClick={() => goMonth(1)}>
          <IconChevron size={14} />
        </button>
      </div>
      <section className="card cal-card cal-mini">
        <div className="cal-grid cal-dow">
          {DOW.map((d) => (
            <span key={d}>{d}</span>
          ))}
        </div>
        <div className="cal-grid">
          {cells.map(({ ms, inMonth }) => {
            const k = dayKey(ms);
            const list = byDay.get(k) ?? [];
            const cls = [
              "cal-day",
              inMonth ? "" : "dim",
              k === todayKey ? "today" : "",
              k === sel ? "selected" : "",
            ].join(" ");
            return (
              <button
                key={k}
                className={cls}
                onClick={() => clickDay(k)}
                aria-label={`${k}, ${list.length} Termine dieses Fachs`}
              >
                <span className="cal-num">{new Date(ms).getDate()}</span>
                <span className="cal-dots">
                  {list.slice(0, 2).map((e) => (
                    <span
                      key={e.uid}
                      className="cal-dot"
                      style={{ background: `hsl(${hue} 70% 50%)` }}
                    />
                  ))}
                  {list.length > 2 && <span className="cal-more">+{list.length - 2}</span>}
                </span>
              </button>
            );
          })}
        </div>
      </section>
      {dayList.length > 1 && (
        <>
          <p className="cal-mini-daylabel">
            {selLabel} · {dayList.length} Termine
          </p>
          <div className="grouped">
            {dayList.map((e) => (
              <button
                key={e.uid}
                className={`row ${e.uid === currentUid ? "current" : ""}`}
                onClick={() => onOpen(e.uid)}
              >
                <span className="cal-time">{formatZeit(e.start)}</span>
                <span className="row-main">
                  <strong>{e.typ}</strong>
                  <span className="row-sub">
                    {formatZeit(e.start)} – {formatZeit(e.end)}
                  </span>
                </span>
                <IconChevron size={14} />
              </button>
            ))}
          </div>
        </>
      )}
    </>
  );
}
