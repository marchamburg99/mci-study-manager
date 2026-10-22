import { useMemo, useState } from "react";
import type { StudyEvent } from "../lib/types";
import { dayKey, formatZeit } from "../lib/focus";
import { fachHue } from "../lib/hue";
import { IconBack, IconChevron } from "./icons";

const DOW = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];

/** Wochenraster Mo–So inkl. anschnittener Nachbartage (Apple-Kalender-Stil). */
export function monthCells(year: number, month: number): { ms: number; inMonth: boolean }[] {
  const first = new Date(year, month, 1);
  const lead = (first.getDay() + 6) % 7;
  const start = new Date(year, month, 1 - lead);
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const trail = (7 - ((lead + daysInMonth) % 7)) % 7;
  const out: { ms: number; inMonth: boolean }[] = [];
  for (let i = 0; i < lead + daysInMonth + trail; i++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    out.push({ ms: d.getTime(), inMonth: d.getMonth() === month });
  }
  return out;
}

export function Kalender({
  events,
  nowMs,
  onOpen,
}: {
  events: StudyEvent[];
  nowMs: number;
  onOpen: (uid: string) => void;
}) {
  const init = new Date(nowMs);
  const [ym, setYm] = useState({ y: init.getFullYear(), m: init.getMonth() });
  const [sel, setSel] = useState<string>(() => dayKey(nowMs));
  const todayKey = dayKey(nowMs);

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

  const agenda = byDay.get(sel) ?? [];
  const selDate = new Date(`${sel}T12:00:00`);
  const agendaLabel = selDate.toLocaleDateString("de-AT", {
    weekday: "long",
    day: "numeric",
    month: "long",
  });

  const goMonth = (d: number) => {
    const n = new Date(ym.y, ym.m + d, 1);
    setYm({ y: n.getFullYear(), m: n.getMonth() });
  };
  const goToday = () => {
    const n = new Date(nowMs);
    setYm({ y: n.getFullYear(), m: n.getMonth() });
    setSel(dayKey(nowMs));
  };

  return (
    <>
      <div className="cal-head">
        <div>
          <h1 className="title sm cal-title">{monthLabel}</h1>
          <p className="subtitle">{events.length} Termine im Plan</p>
        </div>
        <div className="cal-nav">
          <button className="iconbtn" title="Heute" onClick={goToday}>
            <span className="cal-todaybtn">Heute</span>
          </button>
          <button className="iconbtn" title="Voriger Monat" onClick={() => goMonth(-1)}>
            <IconBack size={16} />
          </button>
          <button className="iconbtn" title="Nächster Monat" onClick={() => goMonth(1)}>
            <IconChevron size={16} />
          </button>
        </div>
      </div>

      <section className="card cal-card">
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
              <button key={k} className={cls} onClick={() => setSel(k)} aria-label={`${k}, ${list.length} Termine`}>
                <span className="cal-num">{new Date(ms).getDate()}</span>
                <span className="cal-dots">
                  {list.slice(0, 3).map((e) => (
                    <span
                      key={e.uid}
                      className="cal-dot"
                      style={{ background: `hsl(${fachHue(e.fachKey)} 70% 50%)` }}
                    />
                  ))}
                  {list.length > 3 && <span className="cal-more">+{list.length - 3}</span>}
                </span>
              </button>
            );
          })}
        </div>
      </section>

      <h3 className="section">
        {agendaLabel} <span className="count">{agenda.length}</span>
      </h3>
      {agenda.length === 0 ? (
        <div className="empty">
          <p>Keine Termine an diesem Tag.</p>
        </div>
      ) : (
        <div className="grouped">
          {agenda.map((e) => (
            <button key={e.uid} className="row" onClick={() => onOpen(e.uid)}>
              <span className="cal-time">{formatZeit(e.start)}</span>
              <span
                className="dot"
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
              <IconChevron size={15} />
            </button>
          ))}
        </div>
      )}
    </>
  );
}
