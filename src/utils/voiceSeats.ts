/**
 * `VOICE_MAX_USERS` is the setting and the only one. A deployment still setting
 * `SFU_UDP_PORT_MIN`/`MAX` gets no limit rather than one derived from a range.
 */
export function getVoiceSeatLimit(): number | null {
  const explicit = parseInt(process.env.VOICE_MAX_USERS || "0", 10);
  return explicit > 0 ? explicit : null;
}
