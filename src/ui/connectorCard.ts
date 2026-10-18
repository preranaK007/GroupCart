// Settings "AI assistants" card for the connector (src/connector.ts): Claude, ChatGPT & dots, and Grok.
// Server-rendered from non-secret status only. Connector tokens and pairing codes are created by the
// browser (POST /api/connector/*) and shown once in a dialog; they are never part of the page HTML.
import { connectorView, type ConnectorMemberStatus, type ConnectorView } from "../connector.js";
import type { IntegrationCard } from "./settingsPage.js";
import { button, chip, dialog, escapeHtml, icon, infoTip } from "./shell.js";

function lastUsedLabel(iso: string | null, now = Date.now()): string {
  if (!iso) return "not used yet";
  const minutes = Math.round((now - Date.parse(iso)) / 60_000);
  if (minutes < 1) return "used just now";
  if (minutes < 60) return `used ${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `used ${hours} h ago`;
  return `used ${new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
}

function copyableUrl(url: string): string {
  return `<code class="cc-url">${escapeHtml(url)}</code><button type="button" class="gc-btn gc-btn-text gc-btn-sm cc-copy" data-copy="${escapeHtml(url)}">Copy</button>`;
}

function memberHtml(member: ConnectorMemberStatus): string {
  const pills: string[] = [];
  if (member.token) {
    pills.push(`<span class="cc-conn"><strong>Claude</strong><span class="cc-meta">token · ${escapeHtml(lastUsedLabel(member.token.lastUsedAt))}</span><button type="button" class="cc-x" data-cc-revoke="${escapeHtml(member.id)}" data-cc-name="${escapeHtml(member.name)}" aria-label="Revoke ${escapeHtml(member.name)}'s Claude token" title="Revoke">${icon("close", { size: 14 })}</button></span>`);
  }
  for (const connection of member.connections) {
    const label = connection.clientName && connection.clientName !== connection.via ? `${connection.via} (${connection.clientName})` : connection.via;
    pills.push(`<span class="cc-conn" title="${escapeHtml(`${connection.clientName} · returns to ${connection.redirectHost}`)}"><strong>${escapeHtml(label)}</strong><span class="cc-meta">${escapeHtml(lastUsedLabel(connection.lastUsedAt))}</span><button type="button" class="cc-x" data-cc-revoke-grant="${escapeHtml(connection.grantId)}" data-cc-label="${escapeHtml(`${label} for ${member.name}`)}" aria-label="Disconnect ${escapeHtml(label)}" title="Disconnect">${icon("close", { size: 14 })}</button></span>`);
  }
  // No "Not connected" chip: the buttons beside the name already say so (and the card header shows the status).
  const pairing = member.pairingExpiresAt
    ? `<span class="cc-meta">Code active until ${escapeHtml(new Date(member.pairingExpiresAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }))}</span>`
    : "";
  return pills.join("") + pairing
    + button({ label: "Pairing code", variant: "tonal", size: "sm", icon: "lock", attrs: `data-cc-pair="${escapeHtml(member.id)}"` })
    + button({ label: member.token ? "New Claude token" : "Connect Claude", variant: "outline", size: "sm", icon: "plug", attrs: `data-cc-connect="${escapeHtml(member.id)}"` });
}

function toolsHtml(view: ConnectorView): string {
  const count = view.toolGroups.reduce((sum, group) => sum + group.tools.length, 0);
  if (!count) return '<span class="gc-muted">None registered</span>';
  const groups = view.toolGroups.map((group) => `<div class="cc-group"><div class="cc-group-name">${escapeHtml(group.group)}</div><ul class="cc-tool-list">${group.tools.map((tool) => `<li title="${escapeHtml(tool.description)}"><code>${escapeHtml(tool.name)}</code>${tool.mutates ? '<span class="cc-tag">changes data</span>' : ""}</li>`).join("")}</ul></div>`).join("");
  return `<details class="cc-tools"><summary>${count} tool${count === 1 ? "" : "s"}</summary><div class="cc-groups">${groups}</div></details>`;
}

function publicUrlBlock(view: ConnectorView): string {
  if (view.publicUrl && view.publicHttps) {
    return `<div class="cc-public"><span class="cc-meta">Server URL</span>${copyableUrl(view.publicUrl)}</div>`;
  }
  return `<p class="cc-warn">${icon("alert", { size: 16 })}<span>Needs a public HTTPS URL. On this computer run <code>cloudflared tunnel --url http://127.0.0.1:${view.port}</code>, set <code>GROUP_CART_PUBLIC_URL</code> to the https address it prints, and restart GroupCart. Through the tunnel only <code>/mcp</code> and the sign-in pages answer.</span></p>`;
}

const PAIR = "<strong>Pairing code</strong> (press it next to your name on this page)";

function setupTabs(view: ConnectorView): string {
  const tabs = [
    {
      id: "claude",
      label: "Claude",
      body: `<ol class="cc-steps">
  <li><strong>Claude Code:</strong> press <strong>Connect Claude</strong> next to your name and run the command it shows. Or run <code>claude mcp add --transport http groupcart ${escapeHtml(view.publicUrl ?? view.localUrl)}</code>, open <code>/mcp</code> in Claude Code, and sign in with a ${PAIR}.</li>
  <li><strong>claude.ai or Claude Desktop:</strong> Settings &gt; Connectors &gt; Add custom connector. Name it GroupCart and paste the server URL below. Claude opens GroupCart's sign-in page: enter a ${PAIR}, then press Allow.</li>
  <li>Claude Desktop can also use this computer directly: the <strong>Connect Claude</strong> dialog has a local config snippet.</li>
</ol>${publicUrlBlock(view)}`,
    },
    {
      id: "chatgpt",
      label: "ChatGPT & dots",
      body: `<ol class="cc-steps">
  <li>In ChatGPT, open Settings &gt; Apps &amp; Connectors &gt; Advanced and turn on <strong>Developer mode</strong> (on some plans it's under Security).</li>
  <li>Add a custom connector: name it GroupCart, paste the server URL below, and choose <strong>OAuth</strong> (leave client ID and secret blank).</li>
  <li>ChatGPT opens GroupCart's sign-in page: enter a ${PAIR}, then press Allow.</li>
  <li>dots use the same ChatGPT connectors, so turn GroupCart on for your dot.</li>
</ol>${publicUrlBlock(view)}`,
    },
    {
      id: "grok",
      label: "Grok",
      body: `<ol class="cc-steps">
  <li>Open <strong>grok.com/connectors</strong>, then <strong>New Connector</strong> &gt; <strong>Custom</strong>.</li>
  <li>Paste the server URL below and continue to sign in. Grok opens GroupCart's sign-in page: enter a ${PAIR}, then press Allow.</li>
  <li>Grok rejects localhost and private addresses, so it needs the tunnel. Quick-tunnel addresses change on restart; then remove the connector in Grok and add it again.</li>
</ol>${publicUrlBlock(view)}`,
    },
  ];
  const tablist = tabs.map((tab, index) => `<button type="button" role="tab" class="cc-tab" id="cc-tab-${tab.id}" aria-controls="cc-panel-${tab.id}" aria-selected="${index === 0}" tabindex="${index === 0 ? 0 : -1}">${escapeHtml(tab.label)}</button>`).join("");
  const panels = tabs.map((tab, index) => `<div role="tabpanel" class="cc-panel" id="cc-panel-${tab.id}" aria-labelledby="cc-tab-${tab.id}"${index === 0 ? "" : " hidden"}>${tab.body}</div>`).join("");
  // Collapsed by default: the steps are only needed once per assistant.
  return `<details class="cc-setup"><summary class="cc-setup-head"><h3 class="cc-setup-title">Set up an assistant</h3><span class="cc-meta">Each assistant acts as the roommate who connects it. Posts show as “Name via Claude/ChatGPT/Grok”.</span>${icon("chevronDown", { size: 18, className: "cc-chevron" })}</summary><div class="cc-tabs" role="tablist" aria-label="Assistant">${tablist}</div>${panels}</details>`;
}

const styles = `
#integration-ai-assistants .set-actions { display:block; }
.cc-url { font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace; overflow-wrap:anywhere; text-align:right; }
.cc-meta { color:var(--gc-muted); font-size:var(--gc-fs-xs); }
.cc-conn { display:inline-flex; align-items:center; gap:6px; height:28px; padding:0 4px 0 10px; border-radius:var(--gc-radius-pill); background:var(--gc-success-soft); color:var(--gc-success); font-size:var(--gc-fs-sm); max-width:100%; }
.cc-conn strong { font-weight:500; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.cc-conn .cc-meta { color:inherit; opacity:.85; white-space:nowrap; }
.cc-x { width:22px; height:22px; display:grid; place-items:center; padding:0; border:0; border-radius:50%; background:transparent; color:inherit; cursor:pointer; }
.cc-x:hover { background:color-mix(in srgb, currentColor 14%, transparent); }
.cc-tools { width:100%; text-align:left; }
.cc-tools > summary { cursor:pointer; color:var(--gc-accent); font-size:var(--gc-fs-sm); text-align:right; }
.cc-groups { display:grid; gap:var(--gc-space-3); margin-top:var(--gc-space-3); }
.cc-group-name { font-size:var(--gc-fs-xs); color:var(--gc-muted); text-transform:uppercase; letter-spacing:.04em; margin-bottom:4px; }
.cc-tool-list { list-style:none; margin:0; padding:0; display:flex; flex-wrap:wrap; gap:6px; }
.cc-tool-list li { display:inline-flex; align-items:center; gap:6px; padding:2px 8px; border:1px solid var(--gc-border); border-radius:var(--gc-radius-sm); background:var(--gc-surface-2); }
.cc-tool-list code, .cc-pre code, .cc-steps code, .cc-note code, .cc-warn code { font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace; overflow-wrap:anywhere; }
.cc-tag { font-size:11px; color:var(--gc-warning); }
.cc-setup { border-top:1px solid var(--gc-border); padding-top:var(--gc-space-4); display:grid; gap:var(--gc-space-3); }
.cc-setup-head { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:2px var(--gc-space-2); list-style:none; cursor:pointer; }
.cc-setup-head::-webkit-details-marker { display:none; }
.cc-setup-head .cc-meta { grid-column:1; }
.cc-chevron { grid-column:2; grid-row:1 / span 2; align-self:center; color:var(--gc-muted); transition:transform .15s ease; }
.cc-setup[open] .cc-chevron { transform:rotate(180deg); }
.cc-setup-title { font-size:var(--gc-fs-md); font-weight:500; }
.cc-tabs { display:flex; gap:4px; border-bottom:1px solid var(--gc-border); overflow-x:auto; }
.cc-tab { border:0; background:transparent; color:var(--gc-text-2); font:500 var(--gc-fs-sm) var(--gc-font); padding:8px 14px; border-bottom:2px solid transparent; margin-bottom:-1px; cursor:pointer; white-space:nowrap; }
.cc-tab:hover { color:var(--gc-text); background:var(--gc-hover); }
.cc-tab[aria-selected="true"] { color:var(--gc-accent); border-bottom-color:var(--gc-accent); }
.cc-panel { display:grid; gap:var(--gc-space-3); }
.cc-steps { margin:0; padding-left:20px; display:grid; gap:var(--gc-space-2); color:var(--gc-text-2); font-size:var(--gc-fs-sm); }
.cc-public { display:flex; flex-wrap:wrap; align-items:center; gap:6px 10px; padding:8px 12px; border:1px solid var(--gc-border); border-radius:var(--gc-radius-sm); background:var(--gc-surface-2); }
.cc-public .cc-url { text-align:left; }
.cc-warn { display:flex; gap:8px; align-items:flex-start; margin:0; padding:10px 12px; border-radius:var(--gc-radius-sm); background:var(--gc-warning-soft); color:var(--gc-warning); font-size:var(--gc-fs-sm); }
.cc-warn .gc-icon { margin-top:2px; }
.cc-lead { margin:0 0 var(--gc-space-3); color:var(--gc-text-2); font-size:var(--gc-fs-sm); }
.cc-h { margin:var(--gc-space-4) 0 2px; font-size:var(--gc-fs-md); font-weight:500; }
.cc-note { margin:0 0 6px; color:var(--gc-text-2); font-size:var(--gc-fs-sm); }
.cc-block { position:relative; }
.cc-pre { margin:0; padding:10px 64px 10px 12px; background:var(--gc-surface-2); border:1px solid var(--gc-border); border-radius:var(--gc-radius-sm); white-space:pre-wrap; overflow-wrap:anywhere; max-height:220px; overflow:auto; }
.cc-block .cc-copy { position:absolute; top:6px; right:6px; }
.cc-pair-code { font:500 32px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace; letter-spacing:.14em; text-align:center; padding:var(--gc-space-4); border-radius:var(--gc-radius-md); background:var(--gc-surface-2); border:1px solid var(--gc-border); margin:0 0 var(--gc-space-3); }
`;

const script = `
(function () {
  function code(text) { return GC.esc(text).replace(/\`([^\`]+)\`/g, "<code>$1</code>"); }
  function block(text) {
    return '<div class="cc-block"><pre class="cc-pre"><code>' + GC.esc(text) + '</code></pre><button type="button" class="gc-btn gc-btn-outline gc-btn-sm cc-copy">Copy</button></div>';
  }
  function post(path, body) {
    return fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
      .then(function (response) {
        return response.json().catch(function () { return {}; }).then(function (data) {
          if (!response.ok) throw new Error(data.error || "Request failed.");
          return data;
        });
      });
  }
  function renderToken(data) {
    var html = '<p class="cc-lead">Connector token for <strong>' + GC.esc(data.memberName) + '</strong>. Copy it now: it is shown only once, and anyone with it can act as ' + GC.esc(data.memberName) + ' in GroupCart. Making a new token turns this one off.</p>' + block(data.token);
    data.snippets.forEach(function (snippet) {
      html += '<h3 class="cc-h">' + GC.esc(snippet.title) + '</h3><p class="cc-note">' + code(snippet.note) + '</p>' + (snippet.code ? block(snippet.code) : "");
    });
    document.getElementById("cc-token-body").innerHTML = html;
  }
  function renderPairing(data) {
    var until = new Date(data.expiresAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    var html = '<p class="cc-lead">Pairing code for <strong>' + GC.esc(data.memberName) + '</strong>. Enter it on GroupCart\\'s sign-in page when Claude, ChatGPT, or Grok asks you to connect. It works once and expires at ' + GC.esc(until) + '.</p>'
      + '<p class="cc-pair-code">' + GC.esc(data.code) + '</p>'
      + (data.publicHttps && data.publicUrl ? '<p class="cc-note">Server URL for the connector:</p>' + block(data.publicUrl) : '<p class="cc-note">Hosted assistants need the public HTTPS URL from the tunnel; see the setup tabs.</p>');
    document.getElementById("cc-pair-body").innerHTML = html;
  }
  function copy(button) {
    var text = button.getAttribute("data-copy");
    if (text === null) { var el = button.parentElement && button.parentElement.querySelector("code"); text = el ? el.textContent : ""; }
    var done = function () { var label = button.textContent; button.textContent = "Copied"; setTimeout(function () { button.textContent = label; }, 1500); };
    if (navigator.clipboard && window.isSecureContext) { navigator.clipboard.writeText(text).then(done, function () { fallback(text); done(); }); }
    else { fallback(text); done(); }
  }
  function fallback(text) {
    var area = document.createElement("textarea");
    area.value = text; area.setAttribute("readonly", ""); area.style.position = "fixed"; area.style.opacity = "0";
    document.body.appendChild(area); area.select();
    try { document.execCommand("copy"); } catch (e) {}
    area.remove();
  }
  function selectTab(tab) {
    var list = tab.closest("[role=tablist]");
    list.querySelectorAll("[role=tab]").forEach(function (other) {
      var selected = other === tab;
      other.setAttribute("aria-selected", String(selected));
      other.tabIndex = selected ? 0 : -1;
      var panel = document.getElementById(other.getAttribute("aria-controls"));
      if (panel) panel.hidden = !selected;
    });
    tab.focus();
  }
  ["cc-token-dialog", "cc-pair-dialog"].forEach(function (id) {
    var dialogEl = document.getElementById(id);
    if (dialogEl) dialogEl.addEventListener("close", function () { if (dialogEl.getAttribute("data-dirty")) location.reload(); });
  });
  document.addEventListener("keydown", function (event) {
    var tab = event.target instanceof Element ? event.target.closest(".cc-tab") : null;
    if (!tab || (event.key !== "ArrowRight" && event.key !== "ArrowLeft")) return;
    var tabs = Array.from(tab.parentElement.querySelectorAll(".cc-tab"));
    var next = tabs[(tabs.indexOf(tab) + (event.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
    event.preventDefault();
    selectTab(next);
  });
  document.addEventListener("click", function (event) {
    var target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    var tab = target.closest(".cc-tab");
    if (tab) { selectTab(tab); return; }
    var copyButton = target.closest(".cc-copy");
    if (copyButton) { copy(copyButton); return; }
    var connect = target.closest("[data-cc-connect]");
    if (connect) {
      connect.disabled = true;
      post("/api/connector/tokens", { memberId: connect.getAttribute("data-cc-connect") })
        .then(function (data) { renderToken(data); document.getElementById("cc-token-dialog").setAttribute("data-dirty", "1"); GC.openDialog("cc-token-dialog"); })
        .catch(function (error) { alert(error.message); })
        .then(function () { connect.disabled = false; });
      return;
    }
    var pair = target.closest("[data-cc-pair]");
    if (pair) {
      pair.disabled = true;
      post("/api/connector/pairing", { memberId: pair.getAttribute("data-cc-pair") })
        .then(function (data) { renderPairing(data); document.getElementById("cc-pair-dialog").setAttribute("data-dirty", "1"); GC.openDialog("cc-pair-dialog"); })
        .catch(function (error) { alert(error.message); })
        .then(function () { pair.disabled = false; });
      return;
    }
    var revoke = target.closest("[data-cc-revoke]");
    if (revoke) {
      var name = revoke.getAttribute("data-cc-name") || "this member";
      if (!confirm("Revoke " + name + "'s Claude token? Assistants using it lose access to GroupCart right away.")) return;
      post("/api/connector/tokens/revoke", { memberId: revoke.getAttribute("data-cc-revoke") })
        .then(function () { location.reload(); })
        .catch(function (error) { alert(error.message); });
      return;
    }
    var grant = target.closest("[data-cc-revoke-grant]");
    if (grant) {
      if (!confirm("Disconnect " + (grant.getAttribute("data-cc-label") || "this app") + "? It loses access to GroupCart right away.")) return;
      post("/api/connector/grants/revoke", { grantId: grant.getAttribute("data-cc-revoke-grant") })
        .then(function () { location.reload(); })
        .catch(function (error) { alert(error.message); });
    }
  });
})();
`;

/** The Settings "AI assistants" integration card (rendered by renderIntegrationCard in settingsPage.ts). */
export function claudeConnectorCard(): IntegrationCard {
  const view = connectorView();
  if (!view) {
    return {
      id: "ai-assistants",
      name: "AI assistants",
      icon: "spark",
      summary: "Connect Claude, ChatGPT, or Grok to GroupCart",
      status: { label: "Not configured", tone: "neutral" },
      tip: "The connector starts with GroupCart (setupConnector in src/index.ts).",
    };
  }
  const connected = view.members.filter((member) => member.connected).length;
  const publicFact = view.publicUrl
    ? copyableUrl(view.publicUrl) + (view.publicHttps ? chip("HTTPS", "success", "lock") : chip("Needs HTTPS", "warning", "alert"))
    : chip("Local only", "neutral") + infoTip(`ChatGPT, Grok, and claude.ai need a public HTTPS URL: run "cloudflared tunnel --url http://127.0.0.1:${view.port}" and set GROUP_CART_PUBLIC_URL to its https address. Only /mcp and sign-in pages are reachable through the tunnel.`, "Public access");
  return {
    id: "ai-assistants",
    name: "AI assistants",
    icon: "spark",
    summary: "Claude, ChatGPT & dots, and Grok act as each roommate",
    status: connected
      ? { label: `${connected} of ${view.members.length} connected`, tone: "success" }
      : { label: "Not connected", tone: "neutral" },
    facts: [
      { label: "This computer", html: copyableUrl(view.localUrl) },
      { label: "Public", html: publicFact },
      ...view.members.map((member) => ({ label: member.name, html: memberHtml(member) })),
      { label: "Tools", html: toolsHtml(view) },
    ],
    actions: setupTabs(view)
      + dialog({ id: "cc-token-dialog", title: "Connect Claude", body: '<div id="cc-token-body"></div>', actions: button({ label: "Done", attrs: "data-gc-close" }) })
      + dialog({ id: "cc-pair-dialog", title: "Pairing code", body: '<div id="cc-pair-body"></div>', actions: button({ label: "Done", attrs: "data-gc-close" }) })
      + `<style>${styles}</style><script>${script}</script>`,
    tip: "Claude Code can use a personal connector token. claude.ai, ChatGPT and dots, and Grok sign in with OAuth: GroupCart asks for a one-time pairing code made here. GroupCart stores only fingerprints of tokens and codes.",
  };
}
