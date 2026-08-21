import express from "express";
import consola from "consola";
import { requireAdminToken } from "../middleware/requireAdminToken";
import { getServerConfig, createServerConfigIfNotExists } from "../db";
import { applyServerSettings, settingsView, type SettingsPatch } from "../settings/serverSettings";

/**
 * The management API: how a tool on this machine reads and changes the
 * settings that live in the server's database rather than its environment.
 *
 * It exists because those settings could not be changed from outside a
 * connected client. They are authorised by ownership, and an operator running
 * the server on their own machine is not necessarily its owner — and should
 * not have to be, to turn off LAN discovery on a box they administer.
 *
 * Every route goes through the shared apply path rather than writing rows, so
 * a change made here withdraws the mDNS advertisement, drops the caches it
 * needs to, writes an audit entry and reaches connected clients, exactly as
 * the same change made from a client would.
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

managementRouter.get("/health", (_req, res) => {
  res.json({ ok: true });
});
