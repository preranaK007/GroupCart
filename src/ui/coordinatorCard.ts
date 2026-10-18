// Settings card for the household coordinator (src/agent/): which roommate connected Claude for the apartment,
// and connect/disconnect. It runs on that roommate's own Claude account through Claude Code on this computer.
import type { CoordinatorStatus } from "../agent/coordinator.js";
import type { Member } from "../store.js";
import type { IntegrationCard } from "./settingsPage.js";
import { button, escapeHtml } from "./shell.js";

export function coordinatorSettingsCard(options: { status: CoordinatorStatus; members: Member[] }): IntegrationCard {
  const { status, members } = options;
  const base = {
    id: "coordinator",
    name: "Claude coordinator",
    icon: "spark" as const,
    summary: "One Claude for the apartment: plans, groceries, money, chores",
    tip: "Runs on the connecting roommate's Claude account through Claude Code on this computer, so Claude Code must be installed and signed in here. It replies in the group chat and uses only GroupCart's tools.",
  };
  if (status.connectedBy) {
    return {
      ...base,
      status: { label: "On", tone: "success" },
      facts: [{ label: "Connected by", html: escapeHtml(status.connectedBy.name) }],
      actions: button({ label: "Disconnect", variant: "outline", size: "sm", attrs: "data-coord-off" }) + script,
    };
  }
  const choices = members.map((member) => `<option value="${escapeHtml(member.id)}">${escapeHtml(member.name)}</option>`).join("");
  return {
    ...base,
    status: { label: "Off", tone: "neutral" },
    actions: `<select class="gc-select" data-coord-member aria-label="Whose Claude">${choices}</select>`
      + button({ label: "Connect Claude", variant: "primary", size: "sm", icon: "spark", attrs: "data-coord-on" }) + script,
  };
}

const script = `<script>
(function () {
  function send(body) {
    return fetch("/api/coordinator", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
      .then(function (response) { if (response.ok) location.reload(); else response.json().then(function (data) { alert(data.error || "Couldn't update the coordinator."); }); });
  }
  var on = document.querySelector("[data-coord-on]");
  if (on) on.addEventListener("click", function () { send({ connect: document.querySelector("[data-coord-member]").value }); });
  var off = document.querySelector("[data-coord-off]");
  if (off) off.addEventListener("click", function () { send({ disconnect: true }); });
})();
</script>`;
