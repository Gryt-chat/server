import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { serverRouter } from "./server";
import { uploadsRouter } from "./uploads";
import { emojisRouter } from "./emojis";

/**
 * Multer reads the body into the heap first, so ahead of the auth check an
 * anonymous 20 MB POST answered 401 having moved RSS by 26 MiB.
 */

type Layer = { name?: string; handle?: unknown };
type RouteLayer = {
  route?: { path: string; methods: Record<string, boolean>; stack: Layer[] };
};

const AUTH = /^(requireBearerToken|requireAdminToken|requirePermission|requireRank)/;
// The `buffer*` wrappers are multer constructed late, once the limit has been
// read, and naming them is what makes this see the avatar route at all.
const MULTER = /^(multerMiddleware|buffer[A-Z]\w*)$/;

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
  it("finds every route that buffers a body", () => {
    // Naming the routes, because a version asking only that some route buffers
    // kept passing while a rename narrowed what it covered.
    assert.ok(allRoutes.length > 0, "no routes were inspected");

    const buffering = allRoutes
      .filter((r) => r.handlers.some((h) => MULTER.test(h)))
      .map((r) => r.label)
      .sort();

    assert.deepEqual(
      buffering,
      ["POST /api/server/icon", "POST /api/uploads/", "POST /api/uploads/avatar"],
      "the set of body-buffering routes changed; if that is deliberate, update this list",
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
