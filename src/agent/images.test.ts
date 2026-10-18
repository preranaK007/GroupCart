// Run with: node --import=tsx --test src/agent/images.test.ts
// The coordinator's image links are untrusted: only public https addresses may be fetched.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchPublicImage, isPrivateAddress } from "./images.js";

test("private, loopback and link-local addresses are refused; public ones pass", () => {
  for (const address of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.5", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1"]) {
    assert.equal(isPrivateAddress(address), true, address);
  }
  for (const address of ["151.101.1.1", "8.8.8.8", "2606:4700::1111"]) assert.equal(isPrivateAddress(address), false, address);
});

test("non-https and private links are rejected before any request", async () => {
  await assert.rejects(fetchPublicImage("http://example.com/a.gif"), /Only https/);
  await assert.rejects(fetchPublicImage("https://127.0.0.1/a.gif"), /private/);
  await assert.rejects(fetchPublicImage("https://[::1]/a.gif"), /private/);
  await assert.rejects(fetchPublicImage("https://example.com:8443/a.gif"), /standard https/);
  await assert.rejects(fetchPublicImage("not a url"), /valid link/);
});
