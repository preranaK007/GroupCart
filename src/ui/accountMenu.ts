/**
 * Account menu in the app bar (profiles & sign-in). renderPage() in ./shell.ts adds an empty
 * <div id="gcMe"> and this script fills it from GET /api/auth/me:
 *   - on the host computer: your avatar, then "Viewing as" to switch which member you act as;
 *   - on another device: your avatar and "Sign out" (or a "Sign in" button when signed out).
 * Also styles photo/emoji avatars (.gc-avatar-photo, .gc-avatar-emoji). No imports, so the shell can use it.
 */

export const ACCOUNT_MENU_CSS = `
.gc-avatar-photo { object-fit:cover; background:var(--gc-surface-2); padding:0; border:0; }
.gc-avatar-emoji { background:color-mix(in srgb, var(--gc-avatar-bg) 22%, var(--gc-surface)); color:var(--gc-text); font-size:calc(var(--gc-avatar-size) * .56); font-weight:400; font-family:"Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",var(--gc-font); }
.gc-me { position:relative; display:flex; align-items:center; flex:none; }
.gc-me:empty { display:none; }
.gc-me-btn { display:grid; place-items:center; width:40px; height:40px; padding:0; border:0; border-radius:50%; background:transparent; cursor:pointer; }
.gc-me-btn:hover { background:var(--gc-hover); }
.gc-me-pop { position:absolute; top:calc(100% + 8px); right:0; z-index:40; width:min(300px, calc(100vw - 24px)); padding:var(--gc-space-2) 0; background:var(--gc-surface); color:var(--gc-text); border:1px solid var(--gc-border); border-radius:var(--gc-radius-lg); box-shadow:0 4px 16px rgba(0,0,0,.14); }
.gc-me-head { display:flex; align-items:center; gap:var(--gc-space-3); padding:var(--gc-space-2) var(--gc-space-4) var(--gc-space-3); border-bottom:1px solid var(--gc-border); margin-bottom:var(--gc-space-1); }
.gc-me-name { font-weight:500; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.gc-me-sub { color:var(--gc-muted); font-size:var(--gc-fs-xs); }
.gc-me-item { display:flex; align-items:center; gap:var(--gc-space-3); width:100%; min-height:40px; padding:0 var(--gc-space-4); border:0; background:transparent; color:var(--gc-text); font:var(--gc-fs-md) var(--gc-font); text-align:left; text-decoration:none; cursor:pointer; }
.gc-me-item:hover, .gc-me-item:focus-visible { background:var(--gc-hover); outline:none; }
.gc-me-item .gc-icon { color:var(--gc-text-2); }
.gc-me-label { padding:var(--gc-space-2) var(--gc-space-4) var(--gc-space-1); color:var(--gc-muted); font-size:var(--gc-fs-xs); font-weight:500; border-top:1px solid var(--gc-border); margin-top:var(--gc-space-1); }
.gc-me-item[aria-checked="true"] { font-weight:500; }
.gc-me-check { margin-left:auto; color:var(--gc-accent); }
`;

export const ACCOUNT_MENU_SCRIPT = `
(function () {
  var slot = document.getElementById("gcMe");
  if (!slot || !window.fetch) return;
  var GC = window.GC;
  function item(href, iconName, label) {
    return '<a class="gc-me-item" role="menuitem" href="' + href + '">' + GC.icon(iconName) + '<span>' + GC.esc(label) + '</span></a>';
  }
  function close() {
    var pop = slot.querySelector(".gc-me-pop");
    var btn = slot.querySelector(".gc-me-btn");
    if (pop) pop.hidden = true;
    if (btn) btn.setAttribute("aria-expanded", "false");
  }
  function render(me) {
    var ids = me.householdIds || [];
    var mine = me.member;
    var sub = me.via === "local" ? (me.demoMode ? "Demo · this computer" : "This computer") : "Signed in";
    var html = '<button type="button" class="gc-me-btn" aria-haspopup="menu" aria-expanded="false" aria-label="Account: ' + GC.esc(mine.name) + '">' + GC.avatar(mine, ids, 32) + '</button>'
      + '<div class="gc-me-pop" role="menu" hidden>'
      + '<div class="gc-me-head">' + GC.avatar(mine, ids, 44) + '<div style="min-width:0"><div class="gc-me-name">' + GC.esc(mine.name) + '</div><div class="gc-me-sub">' + GC.esc(sub) + '</div></div></div>'
      + item("/people/" + encodeURIComponent(mine.id), "person", "Your profile")
      + item("/people", "users", GC.t ? GC.t("nav.people", "People") : "People")
      + item("/settings", "settings", GC.t ? GC.t("nav.settings", "Settings") : "Settings");
    if (me.via === "local" && me.members && me.members.length > 1) {
      html += '<div class="gc-me-label">Viewing as</div>' + me.members.map(function (m) {
        var on = m.id === mine.id;
        return '<button type="button" class="gc-me-item" role="menuitemradio" aria-checked="' + on + '" data-view-as="' + GC.esc(m.id) + '">' + GC.avatar(m, ids, 24) + '<span>' + GC.esc(m.name) + '</span>' + (on ? '<span class="gc-me-check">' + GC.icon("check") + '</span>' : '') + '</button>';
      }).join("");
    }
    if (me.via === "session") {
      html += '<div class="gc-me-label"></div><button type="button" class="gc-me-item" role="menuitem" data-sign-out>' + GC.icon("logout") + '<span>Sign out</span></button>';
    }
    html += '</div>';
    slot.innerHTML = html;
  }
  slot.addEventListener("click", function (event) {
    var target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    var btn = target.closest(".gc-me-btn");
    if (btn) {
      var pop = slot.querySelector(".gc-me-pop");
      var open = pop.hidden;
      pop.hidden = !open;
      btn.setAttribute("aria-expanded", String(open));
      if (open) { var first = pop.querySelector(".gc-me-item"); if (first) first.focus(); }
      return;
    }
    var viewAs = target.closest("[data-view-as]");
    if (viewAs) {
      fetch("/api/auth/view-as", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ memberId: viewAs.getAttribute("data-view-as") }) })
        .then(function () { location.reload(); });
      return;
    }
    if (target.closest("[data-sign-out]")) {
      fetch("/api/auth/signout", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })
        .then(function () { location.href = "/signin"; });
    }
  });
  document.addEventListener("click", function (event) { if (!slot.contains(event.target)) close(); });
  document.addEventListener("keydown", function (event) { if (event.key === "Escape") close(); });
  fetch("/api/auth/me", { headers: { accept: "application/json" } })
    .then(function (response) { return response.ok ? response.json() : null; })
    .then(function (me) {
      if (!me) return;
      window.GC_ME = me;
      if (!me.signedIn || !me.member) { slot.innerHTML = '<a class="gc-btn gc-btn-tonal gc-btn-sm" href="/signin">Sign in</a>'; return; }
      render(me);
      document.dispatchEvent(new CustomEvent("gc:me", { detail: me }));
    })
    .catch(function () {});
})();
`;
