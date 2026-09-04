import { existsSync, unlinkSync, writeFileSync } from "fs";
import { consola } from "consola";

import { getServerConfig } from "./db";

declare module "bonjour-service" {
  interface ServiceConfig {
    interface?: string;
    bind?: string;
  }
}

const AVAHI_SERVICE_DIR = "/etc/avahi/services";

/**
 * Where this server writes its avahi advertisement. One file per server: two
 * on one host share this directory, both wrote `gryt.service`, and the second
 * to start overwrote the first with nothing erroring (GRYT-227).
 *
 * Keyed on the port as well as the instance id — SERVER_INSTANCE_ID defaults to
 * "default", so on its own it collides for exactly this deployment.
 */
function avahiServicePath(serverId: string, port: number): string {
  const slug = `${serverId}-${port}`.replace(/[^a-zA-Z0-9._-]/g, "_");
  return `${AVAHI_SERVICE_DIR}/gryt-${slug}.service`;
}

/**
 * Remove the shared file older versions wrote. Quiet on failure: another server
 * may still be on the old build and using it.
 */
function removeLegacyServiceFile(): void {
  try {
    const legacy = `${AVAHI_SERVICE_DIR}/gryt.service`;
    if (existsSync(legacy)) unlinkSync(legacy);
  } catch {
    // not ours to remove
  }
}

/** The path this process wrote, so cleanup removes its own and nobody else's. */
let avahiServicePathWritten: string | null = null;

let usingAvahi = false;
let advertising = false;
let advertisedPort: number | null = null;

export function advertiseMdns(port: number): void {
  if (advertising) return;

  const name = process.env.SERVER_NAME || "Gryt Server";
  const serverId = process.env.SERVER_INSTANCE_ID || "default";

  advertising = true;
  advertisedPort = port;

  // The version is deliberately not in the advertisement. mDNS is a broadcast
  // with no requester to identify, so there is no authorised variant of it —
  // publishing the build number here hands anyone on the network a list of
  // hosts to match against known vulnerabilities. /info still reports it, to
  // members. server_id stays: discovery needs it to dedupe.
  if (tryAvahiServiceFile(name, port, serverId)) return;
  void tryBonjour(name, port, serverId);
}

/**
 * Advertise, or stop, to match `discoverable` — a server withholding its
 * details over /info while broadcasting them to the LAN meant very little.
 *
 * Pass the port once at startup; later calls reuse it.
 */
export async function syncMdnsAdvertising(port?: number): Promise<void> {
  if (typeof port === "number") advertisedPort = port;
  if (advertisedPort == null) return;

  let discoverable = true;
  try {
    const cfg = await getServerConfig();
    // No config yet means a server that has not been set up. Those should still
    // be findable, otherwise first-run setup over the LAN is impossible.
    if (cfg && cfg.discoverable === false) discoverable = false;
  } catch (err) {
    consola.warn(
      "mDNS: could not read the discoverable flag — leaving advertising unchanged",
      err
    );
    return;
  }

  if (discoverable) {
    advertiseMdns(advertisedPort);
  } else if (advertising) {
    consola.info("mDNS: discoverable is off — withdrawing the advertisement");
    await stopMdns();
  }
}

let bonjourInstance: {
  destroy: (cb?: () => void) => void;
  unpublishAll: (cb?: () => void) => void;
} | null = null;

function tryAvahiServiceFile(
  name: string,
  port: number,
  serverId: string
): boolean {
  const xml = [
    '<?xml version="1.0" standalone="no"?>',
    '<!DOCTYPE service-group SYSTEM "avahi-service.dtd">',
    "<service-group>",
    `  <name>${escapeXml(name)}</name>`,
    "  <service>",
    "    <type>_gryt._tcp</type>",
    `    <port>${port}</port>`,
    `    <txt-record>server_id=${escapeXml(serverId)}</txt-record>`,
    "  </service>",
    "</service-group>",
    "",
  ].join("\n");

  const path = avahiServicePath(serverId, port);

  try {
    writeFileSync(path, xml);
    avahiServicePathWritten = path;
    usingAvahi = true;

    // A server that ran before this change left /etc/avahi/services/gryt.service
    // behind, and nothing will ever clean it up now that we write elsewhere.
    // Avahi would keep publishing whatever that file says, so a stale entry for
    // a server that has moved port or stopped would sit on the network
    // indefinitely.
    removeLegacyServiceFile();
    consola.success(
      `mDNS: advertising "${name}" as _gryt._tcp on port ${port} (avahi service file)`
    );
    return true;
  } catch {
    consola.warn(
      "mDNS: could not write avahi service file — if avahi-daemon is running, " +
        "LAN discovery may not work. Fix: mount /etc/avahi/services into the container " +
        "and ensure it is writable (chmod o+w /etc/avahi/services on the host)."
    );
    return false;
  }
}

async function tryBonjour(
  name: string,
  port: number,
  serverId: string
): Promise<void> {
  const iface = process.env.MDNS_INTERFACE;
  try {
    const { Bonjour } = await import("bonjour-service");
    const bonjour = new Bonjour(
      iface ? { interface: iface, bind: "0.0.0.0" } : undefined
    );
    bonjour.publish({
      name,
      type: "gryt",
      port,
      txt: { server_id: serverId },
    });
    bonjourInstance = bonjour;
    const ifaceMsg = iface ? ` on interface ${iface}` : "";
    consola.success(
      `mDNS: advertising "${name}" as _gryt._tcp on port ${port} (bonjour-service${ifaceMsg})`
    );
  } catch (err) {
    consola.warn("mDNS: failed to advertise service", err);
  }
}

export async function stopMdns(): Promise<void> {
  advertising = false;

  if (usingAvahi) {
    try {
      if (avahiServicePathWritten && existsSync(avahiServicePathWritten)) {
        unlinkSync(avahiServicePathWritten);
      }
      avahiServicePathWritten = null;
    } catch {
      // best-effort
    }
    usingAvahi = false;
  }

  if (bonjourInstance) {
    const instance = bonjourInstance;
    bonjourInstance = null;

    // destroy() alone tears down the socket without telling anyone, so the
    // record sits in every responder's cache until it times out — measured at
    // over a minute, during which a server that has been made undiscoverable is
    // still listed. unpublishAll() sends the goodbye packets that actually
    // retract it, so wait for that before destroying.
    await new Promise<void>((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        resolve();
      };

      // Don't hang shutdown if the goodbye never comes back.
      const timer = setTimeout(done, 2000);

      try {
        instance.unpublishAll(() => {
          clearTimeout(timer);
          done();
        });
      } catch {
        clearTimeout(timer);
        done();
      }
    });

    try {
      instance.destroy();
    } catch {
      // best-effort
    }
  }
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
