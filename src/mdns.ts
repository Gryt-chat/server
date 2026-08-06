import { existsSync, unlinkSync, writeFileSync } from "fs";
import { consola } from "consola";

import { getServerConfig } from "./db";

declare module "bonjour-service" {
  interface ServiceConfig {
    interface?: string;
    bind?: string;
  }
}

const AVAHI_SERVICE_PATH = "/etc/avahi/services/gryt.service";

let usingAvahi = false;
let advertising = false;
let advertisedPort: number | null = null;

export function advertiseMdns(port: number): void {
  if (advertising) return;

  const name = process.env.SERVER_NAME || "Gryt Server";
  const version = process.env.SERVER_VERSION || "1.0.0";
  const serverId = process.env.SERVER_INSTANCE_ID || "default";

  advertising = true;
  advertisedPort = port;

  if (tryAvahiServiceFile(name, port, version, serverId)) return;
  void tryBonjour(name, port, version, serverId);
}

/**
 * Advertise, or stop advertising, to match the server's `discoverable` setting.
 *
 * A server with `discoverable` off already withholds its details from strangers
 * over /info. Broadcasting name, port and instance id to the whole LAN anyway
 * made that setting mean very little, so mDNS follows the same flag.
 *
 * Pass the port once at startup; later calls reuse it, which lets the admin
 * handler re-sync after the setting changes without knowing about the listener.
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
  version: string,
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
    `    <txt-record>version=${escapeXml(version)}</txt-record>`,
    `    <txt-record>server_id=${escapeXml(serverId)}</txt-record>`,
    "  </service>",
    "</service-group>",
    "",
  ].join("\n");

  try {
    writeFileSync(AVAHI_SERVICE_PATH, xml);
    usingAvahi = true;
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
  version: string,
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
      txt: { version, server_id: serverId },
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
      if (existsSync(AVAHI_SERVICE_PATH)) unlinkSync(AVAHI_SERVICE_PATH);
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
