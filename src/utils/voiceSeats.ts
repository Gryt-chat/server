/**
 * How many people may sit in voice at once, or null for no limit.
 *
 * `VOICE_MAX_USERS` is the setting, and the only one.
 *
 * `SFU_UDP_PORT_MIN`/`MAX` used to stand in for it — seats were derived as
 * `max - min + 1` — which read like a port range but was really a seat cap in
 * disguise. The SFU never read those two names at all. That fallback warned on
 * every boot that used it and has been removed: a deployment still setting them
 * gets no limit rather than a limit it did not know it was asking for.
 */
export function getVoiceSeatLimit(): number | null {
  const explicit = parseInt(process.env.VOICE_MAX_USERS || "0", 10);
  return explicit > 0 ? explicit : null;
}
