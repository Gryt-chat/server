import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	buildComponentInfo,
	compareSemver,
	detectChannel,
	parseVersion,
} from "./versionCheck";

describe("the versions this server is willing to compare", () => {
	it("takes a plain release", () => {
		assert.deepEqual(parseVersion("1.6.12"), { release: [1, 6, 12], pre: null });
	});

	it("takes the prerelease shape the release workflows produce", () => {
		assert.deepEqual(parseVersion("1.6.15-beta.1"), {
			release: [1, 6, 15],
			pre: { stage: 1, number: 1 },
		});
	});

	it("takes a leading v off nothing — the caller strips it", () => {
		// fetchLatestVersions does `tag_name.replace(/^v/, "")`, so a tag arrives
		// here already stripped. Anything still carrying one is not from there.
		assert.equal(parseVersion("v1.6.12"), null);
	});

	/**
	 * The door GRYT-306 closed, still closed.
	 *
	 * `git describe` gives this for a build that is not sitting exactly on a
	 * tag. The semver grammar would read `1-gafa06e4` as a valid prerelease of
	 * 1.0.48 and compare it, which is why the stage list is a closed set rather
	 * than "any identifier".
	 */
	it("refuses git describe output", () => {
		assert.equal(parseVersion("1.0.48-1-gafa06e4"), null);
	});

	it("refuses a stage nothing publishes", () => {
		assert.equal(parseVersion("1.6.15-nightly.1"), null);
	});

	it("refuses a prerelease with no number", () => {
		assert.equal(parseVersion("1.6.15-beta"), null);
	});
});

describe("ordering", () => {
	it("orders by the three numbers first", () => {
		assert.ok((compareSemver("1.6.15", "1.6.12") ?? 0) > 0);
		assert.ok((compareSemver("1.6.12", "1.7.0") ?? 0) < 0);
	});

	it("puts a prerelease below the release it leads to", () => {
		assert.ok((compareSemver("1.6.15-beta.1", "1.6.15") ?? 0) < 0);
		assert.ok((compareSemver("1.6.15", "1.6.15-beta.1") ?? 0) > 0);
	});

	it("puts a prerelease above the release before it", () => {
		assert.ok((compareSemver("1.6.15-beta.1", "1.6.14") ?? 0) > 0);
	});

	it("orders betas by their number, and stages by rank", () => {
		assert.ok((compareSemver("1.6.15-beta.2", "1.6.15-beta.1") ?? 0) > 0);
		assert.ok((compareSemver("1.6.15-alpha.9", "1.6.15-beta.1") ?? 0) < 0);
		assert.ok((compareSemver("1.6.15-rc.1", "1.6.15-beta.9") ?? 0) > 0);
		assert.equal(compareSemver("1.6.15-beta.1", "1.6.15-beta.1"), 0);
	});

	it("still answers null when either side is not comparable", () => {
		assert.equal(compareSemver("1.0.48-1-gafa06e4", "1.0.49"), null);
		assert.equal(compareSemver("1.0.49", "1.0.48-1-gafa06e4"), null);
	});
});

/**
 * The bug this was opened for (GRYT-722).
 *
 * A client release embeds the newest *stable* server, so nobody had run a
 * server on a beta of itself. Doing it fell down the unparseable branch: the
 * server called itself stable, took the newest stable release as `latest` —
 * older than the thing running — and reported no update, for good.
 */
describe("a server running a beta of itself", () => {
	const stable = "1.6.12";
	const beta = "1.6.15-beta.1";

	it("knows it is on the beta channel", () => {
		assert.equal(detectChannel(beta, stable, beta), "beta");
	});

	it("compares against the newest beta rather than the newest stable", () => {
		const info = buildComponentInfo(beta, { stable, beta });
		assert.equal(info.channel, "beta");
		assert.equal(info.latest, beta);
		assert.equal(info.updateAvailable, false);
	});

	it("is offered the next beta", () => {
		const info = buildComponentInfo(beta, { stable, beta: "1.6.16-beta.1" });
		assert.equal(info.updateAvailable, true);
		assert.equal(info.latest, "1.6.16-beta.1");
	});

	it("is offered the stable that supersedes it", () => {
		const info = buildComponentInfo(beta, { stable: "1.6.15", beta });
		assert.equal(info.channel, "stable");
		assert.equal(info.latest, "1.6.15");
		assert.equal(info.updateAvailable, true);
	});
});

describe("a server running a stable release", () => {
	it("is not pulled onto the beta channel by a newer beta existing", () => {
		const info = buildComponentInfo("1.6.12", { stable: "1.6.12", beta: "1.6.15-beta.1" });
		assert.equal(info.channel, "stable");
		assert.equal(info.latest, "1.6.12");
		assert.equal(info.updateAvailable, false);
	});

	it("is offered a newer stable", () => {
		const info = buildComponentInfo("1.6.12", { stable: "1.6.15", beta: null });
		assert.equal(info.updateAvailable, true);
	});
});

describe("a build that cannot be placed", () => {
	it("says nothing rather than guessing low", () => {
		const info = buildComponentInfo("1.0.48-1-gafa06e4", { stable: "1.0.49", beta: null });
		assert.equal(info.channel, "stable");
		assert.equal(info.updateAvailable, false);
	});
});
