// Run with: node --import=tsx --test src/auth.test.ts
// Invite links: a host-made link signs one roommate in on a few devices until it expires, and a new link
// replaces the old one. In-memory database, fixed clock.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { AuthService, INVITE_MAX_USES, INVITE_TTL_MS } from "./auth.js";
import type { Member } from "./store.js";

const members: Member[] = [{ id: "m-ana", handle: "demo:ana", name: "Ana" }, { id: "m-ben", handle: "demo:ben", name: "Ben" }];

function setup() {
  let now = Date.UTC(2026, 9, 18, 12);
  const auth = new AuthService({ db: new DatabaseSync(":memory:"), members: () => members, memberConfigs: [], demoMode: true, now: () => now });
  return { auth, advance: (ms: number) => { now += ms; } };
}

test("an invite link signs its roommate in on a few devices", () => {
  const { auth } = setup();
  const { token } = auth.createInvite("m-ben");
  for (let device = 0; device < INVITE_MAX_USES; device += 1) {
    const result = auth.redeemInvite(token, `device-${device}`);
    assert.ok(result.ok && result.member.id === "m-ben" && result.token);
  }
  const extra = auth.redeemInvite(token, "one-more");
  assert.ok(!extra.ok && /expired or was replaced/.test(extra.error));
});

test("invite links expire, and a new link replaces the old one", () => {
  const { auth, advance } = setup();
  const first = auth.createInvite("m-ana").token;
  const second = auth.createInvite("m-ana").token;
  assert.equal(auth.redeemInvite(first, "a").ok, false, "the old link stops working");
  assert.equal(auth.redeemInvite(second, "b").ok, true);
  advance(INVITE_TTL_MS + 1);
  assert.equal(auth.redeemInvite(second, "c").ok, false, "a week later it has expired");
  assert.equal(auth.redeemInvite("not-a-token", "d").ok, false);
  assert.throws(() => auth.createInvite("m-nobody"), /Not a household member/);
});
