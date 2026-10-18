// /calendar view state <-> URL (?view=day&date=YYYY-MM-DD), shared by the page
// script and the tests. CALENDAR_STATE_SCRIPT is plain browser JavaScript (no
// build step) defining `CalendarState`; calendarStateHelpers() evaluates the very
// same source so calendarDetail.test.ts checks what the browser runs.
//
// Rules
//   - view: "week" | "day". Without ?view=, phones (<= 640px) open Day, wider screens Week.
//   - date: the selected day (Week view shows the Monday-Sunday week around it). null = today.
//     ?week=YYYY-MM-DD (older links, the Home "Upcoming" card) still works as a date.
//   - URL: view=day is always written; view=week only on phones (where it is not the default);
//     date only when it is not today. Other query params are kept.
//   - step: Day view moves one day, Week view seven days.

export type CalendarViewName = "week" | "day";
export type CalendarViewState = { view: CalendarViewName; date: string | null };

export const CALENDAR_STATE_SCRIPT = String.raw`
var CalendarState = (function () {
  var DATE = /^\d{4}-\d{2}-\d{2}$/;
  function isDate(value) {
    if (typeof value !== "string" || !DATE.test(value)) return false;
    var d = new Date(value + "T00:00:00Z");
    return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
  }
  function addDays(date, days) {
    var d = new Date(date + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  }
  function mondayOf(date) {
    var d = new Date(date + "T00:00:00Z");
    return addDays(date, -((d.getUTCDay() + 6) % 7));
  }
  function defaultView(phone) { return phone ? "day" : "week"; }
  function parse(search, phone) {
    var params = new URLSearchParams(search || "");
    var view = params.get("view");
    var date = params.get("date");
    var week = params.get("week");
    return {
      view: view === "day" || view === "week" ? view : defaultView(phone),
      date: isDate(date) ? date : isDate(week) ? week : null,
    };
  }
  function normalize(state, today) {
    return { view: state.view === "day" ? "day" : "week", date: state.date && state.date !== today && isDate(state.date) ? state.date : null };
  }
  function search(state, today, phone, current) {
    var params = new URLSearchParams(current || "");
    var next = normalize(state, today);
    params.delete("view"); params.delete("date"); params.delete("week");
    if (next.view === "day" || next.view !== defaultView(phone)) params.set("view", next.view);
    if (next.date) params.set("date", next.date);
    var text = params.toString();
    return text ? "?" + text : "";
  }
  function step(state, direction, today) {
    var base = state.date || today;
    return normalize({ view: state.view, date: addDays(base, (state.view === "day" ? 1 : 7) * (direction < 0 ? -1 : 1)) }, today);
  }
  function withView(state, view, today) { return normalize({ view: view, date: state.date }, today); }
  function withDate(state, date, view, today) { return normalize({ view: view || state.view, date: date }, today); }
  return { isDate: isDate, addDays: addDays, mondayOf: mondayOf, defaultView: defaultView, parse: parse, normalize: normalize, search: search, step: step, withView: withView, withDate: withDate };
})();
`;

export type CalendarStateHelpers = {
  isDate(value: unknown): boolean;
  addDays(date: string, days: number): string;
  mondayOf(date: string): string;
  defaultView(phone: boolean): CalendarViewName;
  parse(search: string, phone: boolean): CalendarViewState;
  normalize(state: CalendarViewState, today: string): CalendarViewState;
  search(state: CalendarViewState, today: string, phone: boolean, current?: string): string;
  step(state: CalendarViewState, direction: number, today: string): CalendarViewState;
  withView(state: CalendarViewState, view: CalendarViewName, today: string): CalendarViewState;
  withDate(state: CalendarViewState, date: string, view: CalendarViewName | null, today: string): CalendarViewState;
};

/** The browser helpers, evaluated from the same source the page ships (for tests and server use). */
export function calendarStateHelpers(): CalendarStateHelpers {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return new Function(`${CALENDAR_STATE_SCRIPT}\nreturn CalendarState;`)() as CalendarStateHelpers;
}
