// Run with: node --import=tsx --test src/chat.test.ts
// Web chat: a message an AI assistant sends for a member keeps the assistant's name for the chat to show.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import { ChatService } from "./chat.js";
import type { Member } from "./store.js";

const directory = mkdtempSync(join(tmpdir(), "groupcart-chat-"));
const db = new DatabaseSync(":memory:");
after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });

test("connector messages record which assistant sent them; web messages don't", async () => {
  const sami: Member = { id: "m-sami", handle: "demo:sami", name: "Sami" };
  const chat = new ChatService({ db, filesDir: directory, liveMode: false, members: () => [sami], process: async () => null });
  const viaGrok = await chat.send(sami, { text: "add movie Interstellar" }, { source: "connector", via: "Grok", awaitReply: true });
  const typed = await chat.send(sami, { text: "milk" }, { source: "web", awaitReply: true });
  assert.equal(chat.get(viaGrok.message.id)?.via, "Grok");
  assert.equal(chat.get(typed.message.id)?.via, null);
});
