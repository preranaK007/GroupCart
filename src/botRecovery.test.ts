import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { BotRecovery } from "./botRecovery.js";
import { supervise } from "./supervisor.js";

function database() {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE processed_messages (message_id TEXT PRIMARY KEY, reply_text TEXT)");
  return db;
}

test("a failed message does not stop subsequent processing or reveal error details", async () => {
  const db = database();
  const replies: string[] = [], logs: string[] = [];
  const bot = new BotRecovery(db, "home", async (_ref, text) => { replies.push(text); }, Date.now, (log) => logs.push(log));
  await bot.handle("bad", { id: "group" }, async () => { throw new Error("private token"); });
  await bot.handle("good", { id: "group" }, async () => "Added bread");
  assert.equal(replies.length, 2);
  assert.match(replies[0]!, /couldn’t finish/);
  assert.equal(replies[1], "Added bread");
  assert.doesNotMatch(logs.join(""), /private token/);
  db.close();
});

test("a failed send survives restart and retries the saved reply without reapplying the command", async () => {
  const db = database();
  let now = 0, changes = 0;
  const ref = { id: "original-group", phone: "+15555550100" };
  const first = new BotRecovery(db, "home", async () => { throw new Error("offline"); }, () => now, () => {});
  await first.handle("message", ref, async () => { changes++; return "Added bread"; });
  let sends = 0;
  const recovered = new BotRecovery(db, "home", async (target, text) => {
    sends++; assert.deepEqual(target, ref); assert.equal(text, "Added bread");
  }, () => now);
  await recovered.drain(); assert.equal(sends, 0, "backoff respected");
  now = 1000;
  await recovered.drain();
  await recovered.handle("message", ref, async () => { changes++; return "duplicate"; });
  assert.equal(sends, 1); assert.equal(changes, 1);
  db.close();
});

test("recovery restores a committed reply and reports an interrupted unknown outcome without replaying it", async () => {
  const db = database();
  new BotRecovery(db, "home", async () => {});
  db.prepare("INSERT INTO processed_messages VALUES (?, ?)").run("committed", "Saved the cart change");
  for (const id of ["committed", "unknown"]) {
    db.prepare("INSERT INTO bot_reply_deliveries (household_id, message_id, space_id, status) VALUES ('home', ?, 'group', 'processing')").run(id);
  }
  const replies: string[] = [];
  const recovered = new BotRecovery(db, "home", async (_ref, text) => { replies.push(text); });
  await recovered.drain();
  assert.equal(replies[0], "Saved the cart change");
  assert.match(replies[1]!, /some changes may already have been saved/);
  db.close();
});

test("concurrent drains cannot send the same reply twice", async () => {
  const db = database();
  let sends = 0;
  const bot = new BotRecovery(db, "home", async () => { sends++; await new Promise((resolve) => setTimeout(resolve, 5)); });
  const task = bot.handle("message", { id: "group" }, async () => "reply");
  await Promise.all([task, bot.drain(), bot.drain()]);
  assert.equal(sends, 1);
  db.close();
});

test("the supervisor restarts crashes and explicit shutdown does not restart the bot", async () => {
  const children: Array<EventEmitter & { kill: (signal: string) => boolean }> = [];
  let exited = false;
  const supervisor = supervise({
    restartDelayMs: 1, log: () => {}, onExit: () => { exited = true; },
    spawnChild: () => {
      const child = Object.assign(new EventEmitter(), { kill: (_signal: string) => { queueMicrotask(() => child.emit("exit", 0)); return true; } });
      children.push(child);
      return child as unknown as ChildProcess;
    },
  });
  children[0]!.emit("error", new Error("crash"));
  children[0]!.emit("exit", 1);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(children.length, 2, "one restart, even if both error and exit were emitted");
  supervisor.stop();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(exited, true);
  assert.equal(children.length, 2);
});
