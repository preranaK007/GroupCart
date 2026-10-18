import { DIGEST_HOUR, nextDigestLabel } from "../digest.js";
import { activePoints, monthName, monthOf, RULES_TEXT, type MemberPoints, type Standing } from "../points.js";
import { avatarHtml, card, dialog, escapeHtml, infoTip } from "./shell.js";
import { flavored, flavorText, registerFlavor } from "./themes.js";

/**
 * Points and digest pieces shown on existing pages (no new pages):
 *   leaderboardCard(viewerId)   compact "this month" standings at the top of /people
 *   withPointsBadge(id, avatar) small points chip on an avatar (People cards); POINTS_CLIENT_JS has the client
 *                               twin GCPoints.badge() for the Home people card, and GCPoints.check() shows
 *                               GC.celebrate for a level-up the viewer hasn't seen yet
 *   pointsSectionHtml(summary)  the "Points" card on /people/<id> (registerProfileSection)
 *   digestHomeLine()            "Next digest: Sun 6pm" line (with a preview) inside the Home "Upcoming" card
 * Wording follows the skin through flavor keys (Points / XP / Bounty / Runes / Street cred).
 */

registerFlavor({
  "points.unit": { classic: "Points", minecraft: "XP", rdr: "Bounty", elden: "Runes", cyberpunk: "Street cred" },
  "points.unit.lower": { classic: "points", minecraft: "XP", rdr: "bounty", elden: "runes", cyberpunk: "street cred" },
  "points.leaderboard.title": { classic: "Leaderboard", minecraft: "Scoreboard", rdr: "Most Wanted", elden: "Hall of Champions", cyberpunk: "Top Mercs" },
  "points.level": { classic: "Level", minecraft: "Level", rdr: "Rank", elden: "Rune level", cyberpunk: "Level" },
  "points.mvp": { classic: "MVP", minecraft: "MVP", rdr: "Top gun", elden: "Elden Lord", cyberpunk: "Legend" },
  "points.levelup": { classic: "Level up", minecraft: "Level up!", rdr: "Rank up", elden: "Rune level up", cyberpunk: "Level up" },
});

export const POINTS_CSS = `
.gp-av { position:relative; display:inline-flex; flex:none; }
.gp-badge { position:absolute; right:-6px; bottom:-3px; min-width:18px; height:18px; padding:0 5px; display:inline-grid; place-items:center; border-radius:var(--gc-radius-pill); background:var(--gc-surface); color:var(--gc-text-2); border:1px solid var(--gc-border); font:600 10px/1 var(--gc-font); font-variant-numeric:tabular-nums; white-space:nowrap; pointer-events:auto; }
.pp-card .gp-av { margin-bottom:var(--gc-space-2); }
.pp-card .gp-av .gc-avatar { margin-bottom:0; }
.pp-card .gp-badge { right:0; bottom:2px; min-width:24px; height:22px; font-size:11px; }
.lb-card { margin-bottom:var(--gc-space-4); }
.lb-list { list-style:none; margin:0; padding:0; display:grid; grid-template-columns:repeat(auto-fit, minmax(180px, 1fr)); gap:var(--gc-space-2); }
.lb-item { display:flex; align-items:center; gap:var(--gc-space-3); min-width:0; padding:6px var(--gc-space-3) 6px var(--gc-space-2); border-radius:var(--gc-radius-md); color:inherit; text-decoration:none; }
.lb-item:hover { background:var(--gc-hover); }
.lb-item.is-me { background:var(--gc-surface-2); }
.lb-rank { width:16px; flex:none; text-align:center; color:var(--gc-muted); font-size:var(--gc-fs-sm); font-variant-numeric:tabular-nums; }
.lb-main { flex:1; min-width:0; display:grid; }
.lb-name { font-weight:500; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.lb-sub { color:var(--gc-muted); font-size:var(--gc-fs-xs); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.lb-pts { font-size:var(--gc-fs-lg); font-variant-numeric:tabular-nums; font-weight:500; }
.lb-empty { color:var(--gc-muted); font-size:var(--gc-fs-sm); }
.ps-top { display:flex; align-items:baseline; gap:var(--gc-space-2); flex-wrap:wrap; }
.ps-big { font-size:var(--gc-fs-2xl); font-weight:400; font-variant-numeric:tabular-nums; }
.ps-next { display:flex; justify-content:space-between; gap:var(--gc-space-2); margin-top:var(--gc-space-1); color:var(--gc-muted); font-size:var(--gc-fs-xs); }
.ps-badges { display:flex; flex-wrap:wrap; gap:6px; margin-top:var(--gc-space-3); }
.dg-line { display:flex; align-items:center; gap:6px; margin-top:var(--gc-space-3); padding-top:var(--gc-space-2); border-top:1px solid var(--gc-border); }
.dg-open { padding:0; border:0; background:none; color:var(--gc-muted); font:var(--gc-fs-xs) var(--gc-font); cursor:pointer; text-align:left; }
.dg-open:hover { color:var(--gc-text-2); text-decoration:underline; }
.dg-text { margin:0; white-space:pre-wrap; font:var(--gc-fs-md)/1.6 var(--gc-font); color:var(--gc-text); }
@media (max-width: 760px) { .lb-list { grid-template-columns:minmax(0,1fr); gap:0; } }
`;

function compact(points: number): string {
  return points >= 10_000 ? `${Math.round(points / 1000)}k` : points >= 1000 ? `${(points / 1000).toFixed(1).replace(/\.0$/, "")}k` : String(points);
}

// One page render asks for several members' standings; compute them once.
let cached: { at: number; standings: Standing[] } | null = null;
function currentStandings(): Standing[] {
  const points = activePoints();
  if (!points) return [];
  if (!cached || Date.now() - cached.at > 1_000) cached = { at: Date.now(), standings: points.standings() };
  return cached.standings;
}

/** Wraps an avatar with a small chip showing this month's points (nothing when 0 or points are off). */
export function withPointsBadge(memberId: string, avatar: string): string {
  const standing = currentStandings().find((entry) => entry.memberId === memberId);
  if (!standing || standing.month <= 0) return avatar;
  const label = `${standing.month} ${flavorText("points.unit.lower", "points")} this month · ${flavorText("points.level", "Level")} ${standing.level}`;
  return `<span class="gp-av">${avatar}<span class="gp-badge" role="img" aria-label="${escapeHtml(label)}" title="${escapeHtml(label)}">${escapeHtml(compact(standing.month))}</span></span>`;
}

function leaderRow(entry: Standing, ids: string[], viewerId: string | null): string {
  const level = flavored("points.level", "Level");
  const mvp = entry.mvp && entry.month > 0 ? ` <span title="${escapeHtml(flavorText("points.mvp", "MVP"))} so far">👑</span>` : "";
  const streak = entry.streak >= 2 ? ` · <span title="${entry.streak} weeks in a row with every chore done on time">🔥${entry.streak}</span>` : "";
  return `<li><a class="lb-item${entry.memberId === viewerId ? " is-me" : ""}" href="/people/${encodeURIComponent(entry.memberId)}">
  <span class="lb-rank">${entry.rank}</span>${avatarHtml({ id: entry.memberId, name: entry.name }, { allMemberIds: ids, size: 32 })}
  <span class="lb-main"><span class="lb-name">${escapeHtml(entry.name)}${mvp}</span><span class="lb-sub"><span${level.attrs}>${level.html}</span> ${entry.level}${streak}</span></span>
  <span class="lb-pts">${escapeHtml(compact(entry.month))}</span></a></li>`;
}

/** Compact leaderboard card for the top of /people (this month's points). Empty string when points are off. */
export function leaderboardCard(viewerId: string | null): string {
  const points = activePoints();
  if (!points) return "";
  const standings = currentStandings();
  if (!standings.length) return "";
  const ids = standings.map((entry) => entry.memberId);
  const month = monthName(monthOf(points.now()));
  const unit = flavored("points.unit", "Points");
  const body = standings.some((entry) => entry.month > 0)
    ? `<ol class="lb-list">${standings.map((entry) => leaderRow(entry, ids, viewerId)).join("")}</ol>`
    : `<p class="lb-empty">No ${escapeHtml(flavorText("points.unit.lower", "points"))} yet this month.</p>`;
  return `<style>${POINTS_CSS}</style><script>${POINTS_CLIENT_JS}</script>${card({
    title: "Leaderboard",
    flavor: "points.leaderboard",
    icon: "spark",
    className: "lb-card",
    actions: `<span class="gc-meta">${escapeHtml(month)} · <span${unit.attrs}>${unit.html}</span></span>${infoTip(RULES_TEXT, "How points work")}`,
    body,
    id: "pointsLeaderboard",
  })}`;
}

/** Body of the "Points" card on a profile. */
export function pointsSectionHtml(summary: MemberPoints): string {
  const span = Math.max(1, summary.next - summary.floor);
  const pct = Math.min(100, Math.round(((summary.total - summary.floor) / span) * 100));
  const unit = flavored("points.unit.lower", "points");
  const level = flavored("points.level", "Level");
  const badges = summary.badges.map((badge) => `<span class="gc-chip gc-chip-neutral"><span aria-hidden="true">${escapeHtml(badge.emoji)}</span>${escapeHtml(badge.label)}</span>`).join("");
  return `<style>${POINTS_CSS}</style>
<div class="ps-top"><span class="ps-big">${summary.month}</span><span class="gc-meta"><span${unit.attrs}>${unit.html}</span> this month · #${summary.rank}</span></div>
<div class="gc-track" role="progressbar" aria-label="Progress to the next level" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><div class="gc-fill" style="width:${pct}%"></div></div>
<div class="ps-next"><span><span${level.attrs}>${level.html}</span> ${summary.level} · ${summary.total} all-time</span><span>${summary.next - summary.total} to go</span></div>
${badges ? `<div class="ps-badges">${badges}</div>` : ""}`;
}

/** Title for the profile card in the request's skin ("Points", "XP", ...). */
export function pointsSectionTitle(): string {
  return flavorText("points.unit", "Points");
}

/** Client helpers for Home (people-card badges) and level-up celebrations on pages that include it. */
export const POINTS_CLIENT_JS = String.raw`
// Runs once window.GC exists (inline in a card body it waits for DOMContentLoaded).
;(function (run) { if (window.GC) run(); else document.addEventListener("DOMContentLoaded", run); })(function () {
  var GC = window.GC;
  if (!GC || window.GCPoints) return;
  var byId = {}, started = false;
  function compact(n) { return n >= 10000 ? Math.round(n / 1000) + "k" : n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, "") + "k" : String(n); }
  function load() {
    return fetch("/api/points", { headers: { accept: "application/json" } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { if (d && d.standings) { byId = {}; d.standings.forEach(function (s) { byId[s.memberId] = s; }); } return d; })
      .catch(function () { return null; });
  }
  /** Wraps avatar HTML with this month's points chip (the first call starts loading the numbers). */
  function badge(memberId, avatar) {
    if (!started) { started = true; load(); setInterval(load, 30000); }
    var s = byId[memberId];
    if (!s || !(s.month > 0)) return avatar;
    var title = s.month + " " + GC.t("points.unit.lower", "points") + " this month · " + GC.t("points.level", "Level") + " " + s.level;
    return '<span class="gp-av">' + avatar + '<span class="gp-badge" role="img" aria-label="' + GC.esc(title) + '" title="' + GC.esc(title) + '">' + compact(s.month) + '</span></span>';
  }
  /** Shows a level-up the viewer hasn't seen yet (GC.celebrate; no-op in Classic), then marks it seen. */
  function check() {
    return fetch("/api/points/me", { headers: { accept: "application/json" } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (me) {
        if (!me || !me.levelUp) return;
        if (GC.celebrate) GC.celebrate(GC.t("points.levelup", "Level up") + " · " + GC.t("points.level", "Level") + " " + me.levelUp);
        return fetch("/api/points/seen", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      })
      .catch(function () {});
  }
  window.GCPoints = { load: load, badge: badge, check: check };
  check();
  setInterval(check, 20000);
});
`;

/** "Next digest: Sun 6pm" for the Home Upcoming card; tapping it shows a preview. */
export function digestHomeLine(): string {
  return `<div class="dg-line"><button type="button" class="dg-open" id="dgOpen" title="Preview this week’s digest">📬 Next digest: <span id="dgWhen">${escapeHtml(nextDigestLabel(new Date()))}</span></button></div>
${dialog({ id: "dgDialog", title: "Sunday digest", body: `<pre class="dg-text" id="dgText">Loading…</pre>` })}
<style>${POINTS_CSS}</style>
<script>(function () {
  var open = document.getElementById("dgOpen");
  if (!open) return;
  var now = new Date();
  document.getElementById("dgWhen").textContent = now.getDay() === 0 && now.getHours() < ${DIGEST_HOUR} ? "Today 6pm" : "Sun 6pm";
  open.addEventListener("click", function () {
    var text = document.getElementById("dgText");
    text.textContent = "Loading…";
    window.GC.openDialog("dgDialog");
    fetch("/api/digest/preview", { headers: { accept: "application/json" } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { text.textContent = d && d.text ? d.text : "The digest isn’t available right now."; })
      .catch(function () { text.textContent = "The digest isn’t available right now."; });
  });
})();</script>`;
}
