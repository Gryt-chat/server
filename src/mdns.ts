import Bonjour, { type Service } from "bonjour-service";
import { consola } from "consola";

let bonjour: InstanceType<typeof Bonjour> | null = null;
let published: Service | null = null;

export function advertiseMdns(port: number): void {
	const name = process.env.SERVER_NAME || "Gryt Server";
	const version = process.env.SERVER_VERSION || "1.0.0";

	try {
		bonjour = new Bonjour();
		published = bonjour.publish({
			name,
			type: "gryt",
			port,
			txt: { version },
		});
		consola.success(`mDNS: advertising "${name}" as _gryt._tcp on port ${port}`);
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
