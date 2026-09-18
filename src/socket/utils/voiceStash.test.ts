import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import {
  beginVoiceRecoveryGrace,
  forgetStashedVoiceState,
  isVoiceRecoveryGraceActive,
  stashedVoiceState,
  VOICE_RECOVERY_GRACE_MS,
} from "./voiceStash";

const USER = "user-recovery-test";

afterEach(() => {
  forgetStashedVoiceState(USER);
});

describe("voice recovery grace", () => {
  it("keeps a missing SFU user alive while reconnect is still in flight", () => {
    const startedAt = 1_000;
    beginVoiceRecoveryGrace(USER, startedAt);

    assert.equal(isVoiceRecoveryGraceActive(USER, startedAt), true);
    assert.equal(
      isVoiceRecoveryGraceActive(USER, startedAt + VOICE_RECOVERY_GRACE_MS - 1),
      true,
    );
    assert.equal(
      isVoiceRecoveryGraceActive(USER, startedAt + VOICE_RECOVERY_GRACE_MS),
      false,
    );
  });

  it("refreshes the window when the signalling socket comes back", () => {
    beginVoiceRecoveryGrace(USER, 1_000);
    beginVoiceRecoveryGrace(USER, 20_000);

    assert.equal(
      isVoiceRecoveryGraceActive(USER, 20_000 + VOICE_RECOVERY_GRACE_MS - 1),
      true,
    );
  });

  it("clears the grace window on an intentional leave", () => {
    stashedVoiceState.set(USER, {
      voiceChannelId: "voice",
      streamID: "stream",
      nickname: "Recovery",
      screenShareEnabled: false,
      screenShareVideoStreamID: "",
      screenShareAudioStreamID: "",
      cameraEnabled: false,
      cameraStreamID: "",
      isMuted: false,
      isDeafened: false,
    });
    beginVoiceRecoveryGrace(USER, 1_000);

    forgetStashedVoiceState(USER);

    assert.equal(stashedVoiceState.has(USER), false);
    assert.equal(isVoiceRecoveryGraceActive(USER, 1_001), false);
  });
});
