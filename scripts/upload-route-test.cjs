/**
 * Exercises the real uploads router with the db, storage and auth modules
 * stubbed, so the thing under test is the route's own behaviour.
 *
 * What it is actually checking:
 *   1. the bytes reach storage as a path, not a buffer
 *   2. multer's temp file is gone afterwards, on success AND on rejection
 *   3. the ceiling is the server's configured number, not a hardcoded one
 *   4. zero means unlimited and is now reachable
 */
const path = require("path");
const fs = require("fs");
const os = require("os");
const http = require("http");
const { randomBytes } = require("crypto");

const BUILD = process.argv[2];
const req = (m) => require(path.join(BUILD, m));

// --- stubs, installed before the router is loaded -------------------------
let serverConfig = { upload_max_bytes: 10 * 1024 * 1024 };
const putCalls = [];

// tsc compiles `export *` into getter-only, non-configurable properties, so
// neither assignment nor defineProperty works on the barrel. Swap the module's
// exports object in require.cache for a plain copy, then override on that.
function patchModule(rel, overrides) {
  const full = require.resolve(path.join(BUILD, rel));
  const real = require(full);
  const plain = {};
  for (const k of Object.keys(real)) plain[k] = real[k];
  Object.assign(plain, overrides);
  require.cache[full].exports = plain;
  return plain;
}

patchModule("db/index.js", {
  getServerConfig: async () => serverConfig,
  insertFile: async () => {},
  insertImageJob: async () => {},
});
patchModule("storage/index.js", {
  putObject: async (p) => { putCalls.push(p); },
});
patchModule("middleware/requireBearerToken.js", {
  requireBearerToken: (rq, _rs, next) => { rq.tokenPayload = { serverUserId: "u1" }; next(); },
});

process.env.S3_BUCKET = "test-bucket";

const express = require(path.join(process.cwd(), "node_modules/express"));
const { uploadsRouter } = req("routes/uploads.js");

const app = express();
app.use("/uploads", uploadsRouter);
// mirror the real error handler's LIMIT_FILE_SIZE mapping
app.use((err, _rq, rs, _n) => {
  if (err && err.code === "LIMIT_FILE_SIZE") return rs.status(413).json({ error: "file_too_large" });
  rs.status(500).json({ error: String(err && err.message) });
});

function tempFileCount() {
  // multer's diskStorage({}) writes into os.tmpdir() with no extension
  return fs.readdirSync(os.tmpdir()).filter((f) => /^[0-9a-f]{32}$/i.test(f)).length;
}

function post(port, bytes, filename, mimetype) {
  return new Promise((resolve) => {
    const B = "----gryt" + Date.now();
    const head = Buffer.from(
      `--${B}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      `Content-Type: ${mimetype}\r\n\r\n`);
    const tail = Buffer.from(`\r\n--${B}--\r\n`);
    const body = Buffer.concat([head, bytes, tail]);
    const r = http.request({ port, method: "POST", path: "/uploads/",
      headers: { "Content-Type": `multipart/form-data; boundary=${B}`, "Content-Length": body.length } },
      (res) => { let d = ""; res.on("data", (c) => d += c); res.on("end", () => resolve({ status: res.statusCode, body: d })); });
    r.on("error", (e) => resolve({ status: 0, body: String(e) }));
    r.end(body);
  });
}

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "   " + detail : ""}`);
  if (!ok) failures++;
};

const server = app.listen(0, async () => {
  const port = server.address().port;
  const before = tempFileCount();

  // 1. a 5 MB generic file, under the 10 MB configured limit
  putCalls.length = 0;
  let r = await post(port, randomBytes(5 * 1024 * 1024), "a.bin", "application/octet-stream");
  check("5MB under a 10MB limit is accepted", r.status === 201, `status ${r.status} body=${r.body.slice(0,200)}`);
  check("storage got a path, not a buffer",
    putCalls.length === 1 && !!putCalls[0].sourcePath && putCalls[0].body === undefined,
    putCalls[0] ? `sourcePath=${!!putCalls[0].sourcePath} body=${putCalls[0].body === undefined ? "none" : "PRESENT"}` : "no call");
  await new Promise((s) => setTimeout(s, 150));
  check("temp file cleaned up after success", tempFileCount() === before, `${tempFileCount()} vs ${before}`);

  // 2. over the configured limit -> 413, and nothing left behind
  putCalls.length = 0;
  r = await post(port, randomBytes(12 * 1024 * 1024), "big.bin", "application/octet-stream");
  check("12MB over a 10MB limit is refused", r.status === 413, `status ${r.status}`);
  check("nothing written to storage when refused", putCalls.length === 0);
  await new Promise((s) => setTimeout(s, 150));
  check("temp file cleaned up after rejection", tempFileCount() === before, `${tempFileCount()} vs ${before}`);

  // 3. limit raised past the old hardcoded 200MB backstop
  serverConfig = { upload_max_bytes: 300 * 1024 * 1024 };
  putCalls.length = 0;
  r = await post(port, randomBytes(210 * 1024 * 1024), "x.bin", "application/octet-stream");
  check("210MB accepted when the server allows 300MB (old cap was 200MB)", r.status === 201, `status ${r.status} body=${r.body.slice(0,160)}`);
  await new Promise((s) => setTimeout(s, 300));
  check("temp file cleaned up after a large success", tempFileCount() === before, `${tempFileCount()} vs ${before}`);

  // 4. zero means unlimited
  serverConfig = { upload_max_bytes: 0 };
  putCalls.length = 0;
  r = await post(port, randomBytes(220 * 1024 * 1024), "y.bin", "application/octet-stream");
  check("0 means unlimited, 220MB accepted", r.status === 201, `status ${r.status}`);
  await new Promise((s) => setTimeout(s, 300));
  check("temp file cleaned up under unlimited", tempFileCount() === before, `${tempFileCount()} vs ${before}`);

  console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
  server.close();
  process.exit(failures ? 1 : 0);
});
