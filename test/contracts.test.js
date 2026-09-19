import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("研发材料保留所有者与用途", async () => {
  const payload = JSON.parse(await readFile("fixtures/material-rights.json", "utf8"));
  assert.ok(payload.owner_party);
  assert.ok(payload.allowed_purposes.length > 0);
  assert.ok(payload.allowed_receivers.length > 0);
});
