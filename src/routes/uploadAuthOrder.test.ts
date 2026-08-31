import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { serverRouter } from "./server";
import { uploadsRouter } from "./uploads";
import { emojisRouter } from "./emojis";

/**
 * Multer must never run before the thing that decides whether the caller is
 * allowed to be here.
 *
 * `upload.single("file")` reads the request body to completion into the heap
 * (memoryStorage) and only then hands off. Put it ahead of the auth check and
 * an anonymous caller gets a 401 *after* the server has already accepted and
 * held their upload — 25 MB per request on the server icon route by default.
 *
 * Measured against a fresh server on 2026-08-31 before this was fixed: an
 * unauthenticated POST of 20 MB to /api/server/icon answered 401 with
 * size_upload 20000196, and container RSS moved from 112.5 MiB to 138.2 MiB.
 *
 * This asserts the ordering rather than the 401, because the 401 was always
 * correct. The order is the bug.
 */

type Layer = { name?: string; handle?: unknown };
type RouteLayer = {
  route?: { path: string; methods: Record<string, boolean>; stack: Layer[] };
};

const AUTH = /^(requireBearerToken|requireAdminToken|requirePermission|requireRank)/;
const MULTER = /^multerMiddleware$/;

function routesOf(router: unknown, mount: string) {
  const stack = (router as { stack: RouteLayer[] }).stack ?? [];
  return stack
    .filter((l): l is Required<RouteLayer> => Boolean(l.route))
    .map((l) => ({
      label: `${Object.keys(l.route.methods).join(",").toUpperCase()} ${mount}${l.route.path}`,
      handlers: l.route.stack.map((h) => h.name || "<anonymous>"),
    }));
}

const allRoutes = [
  ...routesOf(serverRouter, "/api/server"),
  ...routesOf(uploadsRouter, "/api/uploads"),
  ...routesOf(emojisRouter, "/api/emojis"),
];

describe("multer never runs before authentication", () => {
  it("finds routes to check at all", () => {
    // Guards against the whole suite passing because an import changed shape
    // and routesOf quietly returned nothing.
    assert.ok(allRoutes.length > 0, "no routes were inspected");
    assert.ok(
      allRoutes.some((r) => r.handlers.some((h) => MULTER.test(h))),
      "no multer route was inspected, so this test proves nothing",
    );
  });

  for (const route of allRoutes) {
    const multerAt = route.handlers.findIndex((h) => MULTER.test(h));
    if (multerAt === -1) continue;

    it(`${route.label} authenticates before buffering`, () => {
      const authAt = route.handlers.findIndex((h) => AUTH.test(h));
      assert.notEqual(
        authAt,
        -1,
        `${route.label} runs multer with no auth middleware in front of it: ${route.handlers.join(" -> ")}`,
      );
      assert.ok(
        authAt < multerAt,
        `${route.label} runs multer at ${multerAt} before auth at ${authAt}: ${route.handlers.join(" -> ")}`,
      );
    });
  }
});
