import { consola } from "consola";

let warnedAboutUdpDerivation = false;

/**
 * How many people may sit in voice at once, or null for no limit.
 *
 * `VOICE_MAX_USERS` is the setting. `SFU_UDP_PORT_MIN`/`MAX` used to stand in
 * for it — seats were derived as `max - min + 1` — which read like a port range
 * but was really a seat cap in disguise. Worse, the SFU never read those two at
 * all: it looks for `ICE_UDP_PORT_MIN`/`MAX` and `ICE_UDP_MUX_PORT`, different
 * names entirely. So the pair configured a user limit while appearing to
 * configure the media plane.
 *
 * The derivation is kept so existing deployments don't silently lose their cap
 * on upgrade, but it warns once and should go.
 */
export function getVoiceSeatLimit(): number | null {
  const explicit = parseInt(process.env.VOICE_MAX_USERS || "0", 10);
  if (explicit > 0) return explicit;

  const min = parseInt(process.env.SFU_UDP_PORT_MIN || "0", 10);
  const max = parseInt(process.env.SFU_UDP_PORT_MAX || "0", 10);

  if (min > 0 && max >= min) {
    const derived = max - min + 1;

    if (!warnedAboutUdpDerivation) {
      warnedAboutUdpDerivation = true;
      consola.warn(
        `Deriving the voice seat limit (${derived}) from SFU_UDP_PORT_MIN/MAX. ` +
          `Those are not read by the SFU and only ever set this limit — set ` +
          `VOICE_MAX_USERS=${derived} instead. The fallback will be removed.`
      );
    }

    return derived;
  }

  return null;
}
