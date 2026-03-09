import { existsSync, unlinkSync, writeFileSync } from "fs";
import { consola } from "consola";

declare module "bonjour-service" {
	interface ServiceConfig {
		interface?: string;
		bind?: string;
	}
}

const AVAHI_SERVICE_PATH = "/etc/avahi/services/gryt.service";

let usingAvahi = false;

/**
 * Advertise via an avahi service file when the directory is writable
 * (host-mounted /etc/avahi/services), otherwise fall back to bonjour-service.
 */
export function advertiseMdns(port: number): void {
	const name = process.env.SERVER_NAME || "Gryt Server";
	const version = process.env.SERVER_VERSION || "1.0.0";

	if (tryAvahiServiceFile(name, port, version)) return;
	tryBonjour(name, port, version);
}

let bonjourInstance: { destroy: (cb?: () => void) => void } | null = null;

function tryAvahiServiceFile(name: string, port: number, version: string): boolean {
	const xml = [
		'<?xml version="1.0" standalone="no"?>',
		'<!DOCTYPE service-group SYSTEM "avahi-service.dtd">',
		"<service-group>",
		`  <name>${escapeXml(name)}</name>`,
		"  <service>",
		"    <type>_gryt._tcp</type>",
		`    <port>${port}</port>`,
		`    <txt-record>version=${version}</txt-record>`,
		"  </service>",
		"</service-group>",
		"",
	].join("\n");

	try {
		writeFileSync(AVAHI_SERVICE_PATH, xml);
		usingAvahi = true;
		consola.success(`mDNS: advertising "${name}" as _gryt._tcp on port ${port} (avahi service file)`);
		return true;
	} catch {
		consola.warn(
			"mDNS: could not write avahi service file — if avahi-daemon is running, " +
			"LAN discovery may not work. Fix: mount /etc/avahi/services into the container " +
			"and ensure it is writable (chmod o+w /etc/avahi/services on the host).",
		);
		return false;
	}
}

async function tryBonjour(name: string, port: number, version: string): Promise<void> {
	const iface = process.env.MDNS_INTERFACE;
	try {
		const { Bonjour } = await import("bonjour-service");
		const bonjour = new Bonjour(
			iface ? { interface: iface, bind: "0.0.0.0" } : undefined,
		);
		bonjour.publish({ name, type: "gryt", port, txt: { version } });
		bonjourInstance = bonjour;
		const ifaceMsg = iface ? ` on interface ${iface}` : "";
		consola.success(`mDNS: advertising "${name}" as _gryt._tcp on port ${port} (bonjour-service${ifaceMsg})`);
	} catch (err) {
		consola.warn("mDNS: failed to advertise service", err);
	}
}

export function stopMdns(): void {
	if (usingAvahi) {
		try {
			if (existsSync(AVAHI_SERVICE_PATH)) unlinkSync(AVAHI_SERVICE_PATH);
		} catch {
			// best-effort
		}
		usingAvahi = false;
	}
	if (bonjourInstance) {
		try {
			bonjourInstance.destroy();
		} catch {
			// best-effort
		}
		bonjourInstance = null;
	}
}

function escapeXml(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
