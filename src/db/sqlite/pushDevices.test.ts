import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { initSqlite } from "./connection";
import { dmPreviewKeys, listPushDevices, MAX_PUSH_DEVICES_PER_USER, removePushCapability, removePushDevice, savePushDevice } from "./pushDevices";

const cap = (c: string) => `p_${c.repeat(43)}`;

describe("push devices", () => {
  const dir = mkdtempSync(join(tmpdir(), "gryt-push-"));
  before(async () => {
    process.env.DATA_DIR = dir;
    await initSqlite();
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("keeps one row per install and replaces its capability", () => {
    savePushDevice("u1", "install-1", cap("a"));
    savePushDevice("u1", "install-1", cap("b"));
    assert.deepEqual(listPushDevices("u1"), [{ installId: "install-1", capability: cap("b"), muted: new Set(), loud: new Set(), everyone: false, previewKey: null, mlsDeviceId: null }]);
    removePushDevice("u1", "install-1");
    assert.deepEqual(listPushDevices("u1"), []);
  });

  it("drops a dead capability from every account that had it", () => {
    savePushDevice("u2", "install-2", cap("c"));
    savePushDevice("u3", "install-2", cap("c"));
    removePushCapability(cap("c"));
    assert.deepEqual([...listPushDevices("u2"), ...listPushDevices("u3")], []);
  });

  it("lists a phone's DM preview key by its MLS device, newest registration last (GRYT-2275)", () => {
    const k = (c: string) => ({ key: c.repeat(43), sig: c.repeat(86) });
    savePushDevice("u5", "install-5", cap("e"), { mlsDeviceId: "dev-5", dmPreviewKey: k("x") });
    savePushDevice("u6", "install-6", cap("f"));
    assert.equal(listPushDevices("u5")[0].mlsDeviceId, "dev-5");
    assert.deepEqual([...dmPreviewKeys(["u5", "u6"])], [["dev-5", k("x")]]);
    savePushDevice("u5", "install-5", cap("e"), { mlsDeviceId: "dev-5", dmPreviewKey: k("y") });
    assert.deepEqual(dmPreviewKeys(["u5"]).get("dev-5"), k("y"));
    assert.deepEqual([...dmPreviewKeys([])], []);
  });

  it("holds at most ten phones per account", () => {
    for (let i = 0; i < MAX_PUSH_DEVICES_PER_USER + 3; i++) savePushDevice("u4", `install-${String(i).padStart(2, "0")}`, cap("d"));
    assert.equal(listPushDevices("u4").length, MAX_PUSH_DEVICES_PER_USER);
  });
});
