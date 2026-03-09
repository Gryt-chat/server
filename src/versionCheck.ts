import { consola } from "consola";

interface GitHubRelease {
	tag_name: string;
	prerelease: boolean;
}

interface ComponentVersionInfo {
	current: string;
	latest: string;
	latestStable: string;
	latestBeta: string | null;
	updateAvailable: boolean;
	channel: "stable" | "beta";
}

export interface VersionStatus {
	server: ComponentVersionInfo;
	sfu: (Omit<ComponentVersionInfo, "current"> & { current: string | null }) | null;
}

interface CacheEntry {
	data: { stable: string; beta: string | null };
	fetchedAt: number;
}

const CACHE_TTL_MS = 5 * 60 * 1000;
const GH_API = "https://api.github.com/repos";
const REPOS = { server: "Gryt-chat/server", sfu: "Gryt-chat/sfu" } as const;

const releaseCache = new Map<string, CacheEntry>();

async function fetchLatestVersions(repo: string): Promise<{ stable: string; beta: string | null }> {
	const cached = releaseCache.get(repo);
	if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.data;

	const res = await fetch(`${GH_API}/${repo}/releases?per_page=20`, {
		headers: { Accept: "application/vnd.github+json", "User-Agent": "gryt-server" },
		signal: AbortSignal.timeout(10_000),
	});

	if (!res.ok) throw new Error(`GitHub API ${res.status}: ${res.statusText}`);

	const releases: GitHubRelease[] = await res.json();

	let stable: string | null = null;
	let beta: string | null = null;

	for (const r of releases) {
		const ver = r.tag_name.replace(/^v/, "");
		if (!r.prerelease && !stable) stable = ver;
		if (r.prerelease && !beta) beta = ver;
		if (stable && beta) break;
	}

	const data = { stable: stable || "0.0.0", beta };
	releaseCache.set(repo, { data, fetchedAt: Date.now() });
	return data;
}

function compareSemver(a: string, b: string): number {
	const pa = a.split(".").map(Number);
	const pb = b.split(".").map(Number);
	for (let i = 0; i < 3; i++) {
		const diff = (pa[i] || 0) - (pb[i] || 0);
		if (diff !== 0) return diff;
	}
	return 0;
}

function detectChannel(current: string, latestStable: string, latestBeta: string | null): "stable" | "beta" {
	if (current === latestStable || compareSemver(current, latestStable) <= 0) return "stable";
	if (latestBeta && compareSemver(current, latestStable) > 0) return "beta";
	return "stable";
}

function buildComponentInfo(
	current: string,
	versions: { stable: string; beta: string | null },
): ComponentVersionInfo {
	const channel = detectChannel(current, versions.stable, versions.beta);
	const latest = channel === "beta" && versions.beta ? versions.beta : versions.stable;
	return {
		current,
		latest,
		latestStable: versions.stable,
		latestBeta: versions.beta,
		updateAvailable: compareSemver(latest, current) > 0,
		channel,
	};
}

async function fetchSfuCurrentVersion(): Promise<string | null> {
	const wsHost = process.env.SFU_WS_HOST;
	if (!wsHost) return null;

	const httpUrl = wsHost.replace(/^ws(s?):\/\//, "http$1://");
	try {
		const res = await fetch(`${httpUrl}/health`, { signal: AbortSignal.timeout(5_000) });
		if (!res.ok) return null;
		const data = await res.json();
		return (data as { version?: string }).version ?? null;
	} catch {
		return null;
	}
}

export async function getVersionStatus(): Promise<VersionStatus> {
	const serverVersion = process.env.SERVER_VERSION || "0.0.0";

	const [serverVersions, sfuVersions, sfuCurrent] = await Promise.all([
		fetchLatestVersions(REPOS.server).catch((err) => {
			consola.warn("Version check: failed to fetch server releases", err.message);
			return { stable: "0.0.0", beta: null };
		}),
		process.env.SFU_WS_HOST
			? fetchLatestVersions(REPOS.sfu).catch((err) => {
				consola.warn("Version check: failed to fetch SFU releases", err.message);
				return { stable: "0.0.0", beta: null };
			})
			: null,
		fetchSfuCurrentVersion(),
	]);

	const server = buildComponentInfo(serverVersion, serverVersions);

	let sfu: VersionStatus["sfu"] = null;
	if (sfuVersions) {
		if (sfuCurrent) {
			const info = buildComponentInfo(sfuCurrent, sfuVersions);
			sfu = { ...info, current: sfuCurrent };
		} else {
			sfu = {
				current: null,
				latest: sfuVersions.stable,
				latestStable: sfuVersions.stable,
				latestBeta: sfuVersions.beta,
				updateAvailable: false,
				channel: "stable",
			};
		}
	}

	return { server, sfu };
}
