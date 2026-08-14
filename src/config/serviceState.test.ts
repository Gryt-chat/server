import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { readServiceState, serviceStateVarName } from "./serviceState";

/** A bare env, so a stray value on the real process cannot change an answer. */
function env(vars: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return vars as NodeJS.ProcessEnv;
}

describe("service state", () => {
  it("is in service when nothing is set", () => {
    assert.deepEqual(readServiceState(env()), { inService: true });
  });

  it("treats an empty value as unset rather than as a refusal", () => {
    // A commented-out line that leaves `GRYT_SERVER_ENABLED=` behind should not
    // take the server down.
    assert.deepEqual(readServiceState(env({ GRYT_SERVER_ENABLED: "" })), {
      inService: true,
    });
    assert.deepEqual(readServiceState(env({ GRYT_SERVER_ENABLED: "   " })), {
      inService: true,
    });
  });

  for (const value of ["true", "on", "yes", "1", "enabled", "TRUE", " On "]) {
    it(`accepts ${JSON.stringify(value)} as in service`, () => {
      assert.equal(readServiceState(env({ GRYT_SERVER_ENABLED: value })).inService, true);
    });
  }

  for (const value of ["false", "off", "no", "0", "disabled", "OFF"]) {
    it(`accepts ${JSON.stringify(value)} as closed`, () => {
      assert.equal(readServiceState(env({ GRYT_SERVER_ENABLED: value })).inService, false);
    });
  }

  it("still understands the old variable", () => {
    // The whole point of keeping it: an upgrade must not take somebody's
    // deliberately closed server back online, or their open one down.
    assert.equal(readServiceState(env({ GRYT_AUTH_MODE: "required" })).inService, true);
    assert.equal(readServiceState(env({ GRYT_AUTH_MODE: "disabled" })).inService, false);
  });

  it("lets the new variable win when both are set", () => {
    // So the two can be added and removed in either order without a window
    // where they disagree and the answer depends on which is read first.
    assert.equal(
      readServiceState(env({ GRYT_SERVER_ENABLED: "off", GRYT_AUTH_MODE: "required" })).inService,
      false,
    );
    assert.equal(
      readServiceState(env({ GRYT_SERVER_ENABLED: "on", GRYT_AUTH_MODE: "disabled" })).inService,
      true,
    );
  });

  it("refuses joins on a value it does not understand, rather than guessing", () => {
    // Neither answer is safe. Reading "requried" as on ignores somebody who
    // meant to close the server; reading it as off takes a server down over a
    // typo. Saying so is the only honest option.
    const state = readServiceState(env({ GRYT_SERVER_ENABLED: "requried" }));
    assert.equal(state.inService, false);
    assert.equal("misconfigured" in state && state.misconfigured, "requried");
  });

  it("names the variable the operator actually set", () => {
    assert.equal(serviceStateVarName(env({ GRYT_SERVER_ENABLED: "off" })), "GRYT_SERVER_ENABLED");
    assert.equal(serviceStateVarName(env({ GRYT_AUTH_MODE: "disabled" })), "GRYT_AUTH_MODE");
  });
});
