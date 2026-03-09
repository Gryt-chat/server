import Bonjour, { type Service } from "bonjour-service";
import { consola } from "consola";

declare module "bonjour-service" {
	interface ServiceConfig {
		/** Passed through to multicast-dns; joins the multicast group on this interface IP. */
		interface?: string;
		/** Passed through to multicast-dns; address to bind the UDP socket to. */
		bind?: string;
	}
}

let bonjour: InstanceType<typeof Bonjour> | null = null;
let published: Service | null = null;

export function advertiseMdns(port: number): void {
	const name = process.env.SERVER_NAME || "Gryt Server";
	const version = process.env.SERVER_VERSION || "1.0.0";
	const iface = process.env.MDNS_INTERFACE;

	try {
		bonjour = new Bonjour(
			iface ? { interface: iface, bind: "0.0.0.0" } : undefined,
		);
		published = bonjour.publish({
			name,
			type: "gryt",
			port,
			txt: { version },
		});
		const ifaceMsg = iface ? ` on interface ${iface}` : "";
		consola.success(`mDNS: advertising "${name}" as _gryt._tcp on port ${port}${ifaceMsg}`);
	} catch (err) {
		consola.warn("mDNS: failed to advertise service", err);
	}
}

export function stopMdns(): void {
	if (published) {
		try {
			published.stop?.();
		} catch {
			// best-effort
		}
		published = null;
	}
	if (bonjour) {
		try {
			bonjour.destroy();
		} catch {
			// best-effort
		}
		bonjour = null;
	}
}
