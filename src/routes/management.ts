import express from "express";
import consola from "consola";
import { requireAdminToken } from "../middleware/requireAdminToken";
import { getServerConfig, createServerConfigIfNotExists, usageNumbers } from "../db";
import { planStorageBytes } from "../settings/storageLimit";
import { voiceUsers } from "../socket/voiceUsers";
import { applyServerSettings, settingsView, type SettingsPatch } from "../settings/serverSettings";

/**
 * Whoever runs the box is not necessarily the server's owner. Every route goes
 * through the shared apply path, so the side effects still happen.
 */
export const managementRouter = express.Router();

managementRouter.use(express.json({ limit: "64kb" }));
managementRouter.use(requireAdminToken);

managementRouter.get("/settings", async (_req, res) => {
  try {
    let cfg = await getServerConfig();
    if (!cfg) cfg = (await createServerConfigIfNotExists()).config;
    // isOwner is false: this caller holds the machine's token, not an identity.
    res.json(settingsView(cfg, process.env.SERVER_ID || "", false));
  } catch (e) {
    consola.error("management: reading settings failed", e);
    res.status(500).json({ error: "settings_read_failed", message: "Could not read settings." });
  }
});

managementRouter.patch("/settings", async (req, res) => {
  try {
    const patch = (req.body ?? {}) as SettingsPatch;
    const updated = await applyServerSettings(patch, { serverUserId: null, via: "management" });
    res.json(settingsView(updated, process.env.SERVER_ID || "", false));
  } catch (e) {
    consola.error("management: updating settings failed", e);
    res.status(500).json({ error: "settings_update_failed", message: "Could not update settings." });
  }
});

managementRouter.get("/usage", (_req, res) => {
  try {
    const usage = usageNumbers();
    res.json({ ...usage, storageBytes: { ...usage.storageBytes, limit: planStorageBytes() }, voiceUsers: voiceUsers() });
  } catch (e) {
    consola.error("management: reading usage failed", e);
    res.status(500).json({ error: "usage_read_failed", message: "Could not read usage." });
  }
});

managementRouter.get("/health", (_req, res) => {
  res.json({ ok: true });
});
