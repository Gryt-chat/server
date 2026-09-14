import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

const ROOT = join(__dirname, "..");
const SCRIPT = join(ROOT, "scripts", "describe-version.sh");
const scratch = mkdtempSync(join(tmpdir(), "describe-version-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

const describeVersion = (dir: string) => execFileSync("bash", [SCRIPT, dir], { encoding: "utf8" }).trim();

function git(dir: string, ...args: string[]) {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", ...args], { cwd: dir, encoding: "utf8" }).trim();
}

let n = 0;
function repo(): string {
  const dir = join(scratch, `repo${n++}`);
  mkdirSync(dir);
  git(dir, "init", "-q");
  commit(dir);
  return dir;
}

function commit(dir: string) {
  writeFileSync(join(dir, "f"), String(Math.random()));
  git(dir, "add", "f");
  git(dir, "commit", "-q", "-m", "c");
}

describe("scripts/describe-version.sh", () => {
  it("gives the tag on HEAD without the v", () => {
    const dir = repo();
    git(dir, "tag", "v1.2.3");
    assert.equal(describeVersion(dir), "1.2.3");
  });

  it("picks the highest of two tags on one commit by version, not by string", () => {
    const dir = repo();
    git(dir, "tag", "v1.0.9");
    git(dir, "tag", "v1.0.10");
    assert.equal(describeVersion(dir), "1.0.10");
  });

  it("puts a release above its own beta on the same commit", () => {
    const dir = repo();
    git(dir, "tag", "v1.6.15-beta.1");
    git(dir, "tag", "v1.6.15");
    assert.equal(describeVersion(dir), "1.6.15");
  });

  it("describes a commit past the last tag", () => {
    const dir = repo();
    git(dir, "tag", "v2.0.0");
    commit(dir);
    assert.equal(describeVersion(dir), `2.0.0-1-g${git(dir, "rev-parse", "--short", "HEAD")}`);
  });

  it("falls back to the commit when there are no tags", () => {
    const dir = repo();
    assert.equal(describeVersion(dir), git(dir, "rev-parse", "--short", "HEAD"));
  });

  it("says unknown for a plain folder inside some other checkout", () => {
    const dir = repo();
    git(dir, "tag", "v3.0.0");
    const inner = join(dir, "image-worker");
    mkdirSync(inner);
    assert.equal(describeVersion(inner), "unknown");
  });

  it("says unknown outside git", () => {
    const dir = join(scratch, "plain");
    mkdirSync(dir);
    assert.equal(describeVersion(dir), "unknown");
  });
});

describe("build-selfhosted.sh", () => {
  const build = readFileSync(join(ROOT, "build-selfhosted.sh"), "utf8");

  it("stamps every SFU build with the SFU's own version", () => {
    const builds = build.split("\n").filter((line) => line.includes("go build"));
    assert.equal(builds.length, 2);
    for (const line of builds) assert.match(line, /-ldflags "\$SFU_LDFLAGS"/);
    assert.match(build, /SFU_VERSION=\$\(bash "\$SCRIPT_DIR\/scripts\/describe-version\.sh" "\$SFU_DIR"\)/);
    assert.match(build, /SFU_LDFLAGS="-X main\.Version=\$SFU_VERSION"/);
  });

  it("stamps the image worker with its own version rather than the server's", () => {
    assert.match(build, /IMAGE_WORKER_VERSION=\$\(bash "\$SCRIPT_DIR\/scripts\/describe-version\.sh" "\$IMAGE_WORKER_DIR"\)/);
    assert.match(build, /pkg\.version = '\$IMAGE_WORKER_VERSION';\n\s*require\('fs'\)\.writeFileSync\('\$OUTDIR\/image-worker\/package\.json'/);
  });
});
