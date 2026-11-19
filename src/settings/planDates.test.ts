import assert from "node:assert/strict";
import { test } from "node:test";

import { planDates, setPlanDates } from "./planDates";

test("plan dates keep only real times and clear with null", () => {
  setPlanDates({ readOnlyAt: 1_900_000_000_000, pausedAt: "soon", deletedAt: -5 });
  assert.deepEqual(planDates(), { readOnlyAt: 1_900_000_000_000, pausedAt: undefined, deletedAt: undefined });
  setPlanDates("nonsense");
  assert.equal(planDates().readOnlyAt, 1_900_000_000_000, "garbage leaves them alone");
  setPlanDates(null);
  assert.deepEqual(planDates(), {});
});
