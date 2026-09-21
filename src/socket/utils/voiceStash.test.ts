import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import {
  beginVoiceRecoveryGrace,
  clearVoiceRecoveryGrace,
  forgetStashedVoiceState,
  isVoiceRecoveryGraceActive,
  stashedVoiceState,
  VOICE_RECOVERY_GRACE_MS,
} from "./voiceStash";

const USER = "voice-recovery-test";

afterEach(() => {
  forgetStashedVoiceState(USER);
  clearVoiceRecoveryGrace(USER);
});

describe("voice recovery grace", () => {
  it("keeps a reconnect alive until the explicit deadline", () => {
    const startedAt = 1_000;
    beginVoiceRecoveryGrace(USER, startedAt);

    assert.equal(isVoiceRecoveryGraceActive(USER, startedAt), true);
    assert.equal(
      isVoiceRecoveryGraceActive(
        USER,
        startedAt + VOICE_RECOVERY_GRACE_MS - 1,
      ),
      true,
    );
    assert.equal(
      isVoiceRecoveryGraceActive(USER, startedAt + VOICE_RECOVERY_GRACE_MS),
      false,
    );
  });

  it("refreshes when signaling recovery makes another attempt", () => {
    beginVoiceRecoveryGrace(USER, 1_000);
    beginVoiceRecoveryGrace(USER, 20_000);

    assert.equal(
      isVoiceRecoveryGraceActive(
        USER,
        20_000 + VOICE_RECOVERY_GRACE_MS - 1,
      ),
      true,
    );
  });

  it("keeps the longer deadline when a short wait starts inside it", () => {
    beginVoiceRecoveryGrace(USER, 1_000);
    beginVoiceRecoveryGrace(USER, 2_000, 10_000);

    assert.equal(
      isVoiceRecoveryGraceActive(USER, 1_000 + VOICE_RECOVERY_GRACE_MS - 1),
      true,
    );
  });

  it("clears as soon as the SFU confirms the replacement peer", () => {
    beginVoiceRecoveryGrace(USER, 1_000);
    clearVoiceRecoveryGrace(USER);

    assert.equal(isVoiceRecoveryGraceActive(USER, 1_001), false);
  });

  it("intentional leave clears both held state and recovery grace", () => {
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
      heldAt: 1_000,
    });
    beginVoiceRecoveryGrace(USER, 1_000);

    forgetStashedVoiceState(USER);

    assert.equal(stashedVoiceState.has(USER), false);
    assert.equal(isVoiceRecoveryGraceActive(USER, 1_001), false);
  });
});
