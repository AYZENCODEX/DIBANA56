import assert from "node:assert/strict";
import test from "node:test";
import { getSharedAppCatalog, getSharedAppForHost } from "./shared-apps";

test("shared API catalog exposes the five requested branded apps", () => {
  const ids = getSharedAppCatalog().map((app) => app.id);
  for (const id of ["verve", "ryft", "sylo", "skarn", "warde"]) {
    assert.equal(ids.includes(id), true);
  }
});

test("shared host discovery is case-insensitive and strips ports", () => {
  assert.equal(getSharedAppForHost("RYFT.AYZEN.TECH:443")?.id, "ryft");
  assert.equal(getSharedAppForHost("unknown.ayzen.tech"), null);
});