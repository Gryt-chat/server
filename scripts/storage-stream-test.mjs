/**
 * Round-trips a file larger than the multipart part size through both storage
 * backends, using the sourcePath path, and checks the bytes come back byte for
 * byte. 20 MB against an 8 MB part size means at least three parts, so this
 * genuinely exercises multipart rather than falling back to a single PUT.
 */
import { createHash, randomBytes } from "crypto";
import { mkdtemp, rm, stat, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

process.env.S3_ENDPOINT ||= "http://127.0.0.1:9000";
process.env.S3_ACCESS_KEY_ID ||= "minioadmin";
process.env.S3_SECRET_ACCESS_KEY ||= "minioadmin";
process.env.S3_FORCE_PATH_STYLE = "true";
process.env.S3_REGION ||= "us-east-1";

const storage = await import(process.argv[2]);

const SIZE = 20 * 1024 * 1024;
const BUCKET = "gryt-stream-test";
const dir = await mkdtemp(join(tmpdir(), "gryt-stream-"));
let failures = 0;

function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failures++;
}

try {
  const src = join(dir, "big.bin");
  const payload = randomBytes(SIZE);
  await writeFile(src, payload);
  const expected = createHash("sha256").update(payload).digest("hex");
  console.log(`source: ${SIZE} bytes, sha256 ${expected.slice(0, 16)}…\n`);

  for (const backend of ["s3", "filesystem"]) {
    process.env.STORAGE_BACKEND = backend;
    if (backend === "filesystem") process.env.DATA_DIR = join(dir, "fsdata");
    storage.initStorage();
    await storage.ensureBucket(BUCKET);

    const key = `stream-${backend}-${Date.now()}.bin`;
    const before = process.memoryUsage().heapUsed;
    await storage.putObject({ bucket: BUCKET, key, sourcePath: src, contentType: "application/octet-stream" });
    const peak = process.memoryUsage().heapUsed - before;

    const got = await storage.getObjectAsBuffer({ bucket: BUCKET, key });
    const actual = createHash("sha256").update(got).digest("hex");

    check(`${backend}: round-trips ${SIZE} bytes`, got.length === SIZE, `got ${got.length}`);
    check(`${backend}: bytes identical`, actual === expected, actual.slice(0, 16) + "…");
    check(`${backend}: heap growth under 8MB during put`, peak < 8 * 1024 * 1024,
      `${(peak / 1024 / 1024).toFixed(1)}MB`);

    // the buffer path must still work unchanged
    const bkey = `buffer-${backend}-${Date.now()}.bin`;
    await storage.putObject({ bucket: BUCKET, key: bkey, body: Buffer.from("hello"), contentType: "text/plain" });
    const b = await storage.getObjectAsBuffer({ bucket: BUCKET, key: bkey });
    check(`${backend}: body path still works`, b.toString() === "hello");

    await storage.deleteObject({ bucket: BUCKET, key });
    await storage.deleteObject({ bucket: BUCKET, key: bkey });
    console.log("");
  }
} finally {
  await rm(dir, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
process.exit(failures ? 1 : 0);
