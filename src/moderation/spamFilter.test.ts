import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  countLinks,
  normalizeForSpam,
  normalizeSpamSensitivity,
  SpamFilter,
  textSimilarity,
  wallWeight,
  type ChannelSend,
  type DirectSend,
  type SpamSender,
  type SpamSensitivity,
} from "./spamFilter";
import { isSpamExempt, timeoutMinutesFor } from "./spamTimeout";
import type { Permission } from "../constants/permissions";

const T0 = Date.parse("2026-09-25T12:00:00Z");
const DAY = 24 * 60 * 60_000;

/** Joined long ago, so no new-member weight. */
const regular: SpamSender = { id: "user_regular", memberSince: new Date(T0 - 30 * DAY) };
/** Joined a minute before the first send. */
const newcomer: SpamSender = { id: "user_new", memberSince: new Date(T0 - 60_000) };

function say(text: string, over: Partial<ChannelSend> = {}): ChannelSend {
  return {
    kind: "channel",
    conversationId: "general",
    text,
    userMentions: 0,
    massMentions: 0,
    roleMentions: 0,
    mayMentionEveryone: false,
    attachments: 0,
    ...over,
  };
}

function dm(conversationId: string, recipient: string, over: Partial<DirectSend> = {}): DirectSend {
  return {
    kind: "dm",
    conversationId,
    recipients: [recipient],
    size: 180,
    newConversation: true,
    attachments: 0,
    ...over,
  };
}

/** Sends in order, `gapMs` apart, and returns the 1-based index of the first
    that tripped, or 0 when none did. */
function firstTrip(
  sends: (ChannelSend | DirectSend)[],
  opts: { sender?: SpamSender; sensitivity?: SpamSensitivity; gapMs?: number } = {},
): number {
  const filter = new SpamFilter();
  const sender = opts.sender ?? regular;
  const gap = opts.gapMs ?? 1_000;
  for (let i = 0; i < sends.length; i++) {
    const v = filter.evaluate(sender, sends[i], opts.sensitivity ?? "normal", T0 + i * gap);
    if (v.spam) return i + 1;
  }
  return 0;
}

function repeat<T>(n: number, make: (i: number) => T): T[] {
  return Array.from({ length: n }, (_, i) => make(i));
}

describe("normalizeForSpam", () => {
  it("folds case, spacing, punctuation, zero-width characters and repeated letters", () => {
    const a = normalizeForSpam("FREE  N\u200Bitro!!! click here");
    const b = normalizeForSpam("freeee nitro, click   here");
    assert.equal(a, b);
    assert.equal(a, "frenitroclickhere");
  });

  it("keeps emoji and digits", () => {
    assert.equal(normalizeForSpam("win 100 🎉🎉"), "win10🎉");
  });

  it("drops combining marks, so zalgo text is the text underneath", () => {
    assert.equal(normalizeForSpam("s\u0336p\u0336a\u0336m\u0336"), "spam");
  });
});

describe("textSimilarity", () => {
  it("scores a changed counter as near the same", () => {
    const a = normalizeForSpam("join my server for free nitro giveaway 1");
    const b = normalizeForSpam("join my server for free nitro giveaway 2");
    assert.ok(textSimilarity(a, b) >= 0.8);
  });

  it("scores unrelated sentences low", () => {
    const a = normalizeForSpam("anyone up for a game tonight?");
    const b = normalizeForSpam("the build on main is green again");
    assert.ok(textSimilarity(a, b) < 0.5);
  });
});

describe("countLinks", () => {
  it("counts links and invites, with or without a scheme", () => {
    assert.deepEqual(countLinks("see https://example.com and www.example.org"), { links: 2, invites: 0 });
    assert.deepEqual(countLinks("join discord.gg/abc123 now"), { links: 1, invites: 1 });
    assert.deepEqual(countLinks("https://gryt.chat/invite?host=x.example&code=ABCD"), { links: 1, invites: 1 });
    assert.deepEqual(countLinks("no links here"), { links: 0, invites: 0 });
  });
});

describe("wallWeight", () => {
  it("flags one character or one emoji repeated", () => {
    assert.equal(wallWeight("A".repeat(60)), 1);
    assert.equal(wallWeight("😂".repeat(40)), 1);
    assert.equal(wallWeight("x".repeat(600)), 2);
  });

  it("leaves ordinary long messages and short outbursts alone", () => {
    assert.equal(wallWeight("hahahahahahahahahahahahahahahahahahaha"), 0);
    assert.equal(wallWeight("NOOOOOOOOOOOOOOO"), 0);
    assert.equal(wallWeight("I think the new build fixed the echo, can somebody check on Windows?"), 0);
  });
});

describe("channel signals", () => {
  it("duplicate: the fourth identical message trips at normal", () => {
    assert.equal(firstTrip(repeat(8, () => say("buy cheap followers at my site"))), 4);
  });

  it("duplicate: sensitivity moves it, high at the third and low at the sixth", () => {
    const spam = repeat(8, () => say("buy cheap followers at my site"));
    assert.equal(firstTrip(spam, { sensitivity: "high" }), 3);
    assert.equal(firstTrip(spam, { sensitivity: "low" }), 6);
  });

  it("near-duplicate: disguised copies count as the same text", () => {
    const variants = [
      "FREE NITRO click here to claim 1",
      "free   nitro, click here to claim 2",
      "fr\u200Bee niiitro click here to claim 3",
      "Free Nitro Click Here To Claim 4",
      "free nitro click here to claim 5",
    ].map((t) => say(t));
    assert.equal(firstTrip(variants), 4);
  });

  it("cross-channel: the same text in three channels trips on the third", () => {
    const sends = ["general", "random", "help", "memes"].map((c) => say("check out my stream at twitch", { conversationId: c }));
    assert.equal(firstTrip(sends), 3);
  });

  it("links: a burst of different messages each carrying a link trips on the seventh", () => {
    const lines = ["best deals", "you will love this", "limited time", "click fast", "only today", "last chance", "hurry up", "wow"];
    const sends = lines.map((l, i) => say(`${l} https://shop${i}.example/${"qwertyui"[i]}`));
    assert.equal(firstTrip(sends), 7);
  });

  it("invites: the third invite link in a burst trips", () => {
    const sends = repeat(6, (i) => say(`${["join", "come to", "hop into", "see", "try", "visit"][i]} discord.gg/code${i}`));
    assert.equal(firstTrip(sends), 3);
  });

  it("mentions: one message naming thirteen people trips, twelve does not", () => {
    assert.equal(firstTrip([say("hey everybody look", { userMentions: 13 })]), 1);
    assert.equal(firstTrip([say("hey everybody look", { userMentions: 12 })]), 0);
  });

  it("mentions: a refused @everyone tried three times trips on the third", () => {
    const sends = ["@everyone free stuff", "@everyone hello??", "@everyone look at this"].map((t) => say(t, { massMentions: 1 }));
    assert.equal(firstTrip(sends), 3);
  });

  it("mentions: a storm of messages naming four people each trips on the fourth", () => {
    const sends = repeat(8, (i) => say(`wake up ${"abcdefgh"[i]}`, { userMentions: 4 }));
    assert.equal(firstTrip(sends), 4);
  });

  it("wall: the fourth wall of one character trips", () => {
    const sends = repeat(8, (i) => say(String.fromCharCode(65 + i).repeat(80)));
    assert.equal(firstTrip(sends), 4);
  });

  it("attachments: the sixth message in a burst with three or more files trips", () => {
    const sends = repeat(8, () => say("", { attachments: 4 }));
    assert.equal(firstTrip(sends), 6);
  });
});

describe("DM signals, metadata only", () => {
  it("a brand-new member fanning out to twenty people trips on the fifth", () => {
    const sends = repeat(20, (i) => dm(`dm_${i}`, `user_target_${i}`));
    assert.equal(firstTrip(sends, { sender: newcomer, gapMs: 3_000 }), 5);
  });

  it("the same fan-out from an established member takes longer", () => {
    const sends = repeat(20, (i) => dm(`dm_${i}`, `user_target_${i}`));
    const at = firstTrip(sends, { gapMs: 3_000 });
    assert.ok(at > 5, `tripped at ${at}`);
    assert.ok(at > 0 && at <= 8, `tripped at ${at}`);
  });

  it("fan-out alone, different sizes to existing conversations, takes many more people", () => {
    const sends = repeat(30, (i) => dm(`dm_${i}`, `user_target_${i}`, { newConversation: false, size: 100 + i * 7 }));
    const at = firstTrip(sends, { gapMs: 3_000 });
    assert.ok(at === 0 || at >= 13, `tripped at ${at}`);
  });
});

describe("normal behaviour that must not trip", () => {
  const everySensitivity: SpamSensitivity[] = ["low", "normal", "high"];

  it("a fast typist sending short, different messages", () => {
    const lines = [
      "ok", "lol", "wait what", "no way", "yes", "haha", "brb", "back", "gg", "ok ok",
      "that was close", "did you see that", "lol", "nice", "yes", "one more?", "sure", "go", "ready", "lol",
    ];
    for (const s of everySensitivity) {
      assert.equal(firstTrip(lines.map((l) => say(l)), { gapMs: 800, sensitivity: s }), 0, s);
    }
  });

  it("repeating a short reply like lol", () => {
    for (const s of everySensitivity) {
      assert.equal(firstTrip(repeat(8, () => say("lol")), { sensitivity: s }), 0, s);
    }
  });

  it("somebody pasting one link, then chatting", () => {
    const sends = [say("here is the doc https://docs.example.com/setup"), say("page 3 has it"), say("thanks!")];
    for (const s of everySensitivity) assert.equal(firstTrip(sends, { sensitivity: s }), 0, s);
  });

  it("a conversation with many quick replies", () => {
    const lines = [
      "so is the patch out yet", "I think it went out an hour ago", "the changelog says 1.11.43",
      "mine still says 1.11.42", "restart the app", "oh there it is", "did it fix the echo for you",
      "yes finally", "what about screenshare on linux", "still flickers on wayland for me",
      "same here", "Carlo said it is the portal", "ah that explains it", "anyone want to play later",
      "after dinner", "sounds good", "I will bring snacks", "you cannot bring snacks online",
      "watch me", "fair enough",
    ];
    for (const s of everySensitivity) {
      assert.equal(firstTrip(lines.map((l) => say(l)), { gapMs: 2_000, sensitivity: s }), 0, s);
    }
  });

  it("a member allowed to ping @everyone posting one announcement", () => {
    const sends = [say("@everyone game night starts at 8, voice channel 2", { massMentions: 1, mayMentionEveryone: true }), say("see you there")];
    for (const s of everySensitivity) assert.equal(firstTrip(sends, { sensitivity: s }), 0, s);
  });

  it("the same allowed announcement cross-posted to two channels", () => {
    const sends = ["announcements", "general"].map((c) =>
      say("@everyone release 1.11.43 is out, restart to update", { conversationId: c, massMentions: 1, mayMentionEveryone: true }));
    for (const s of everySensitivity) assert.equal(firstTrip(sends, { gapMs: 5_000, sensitivity: s }), 0, s);
  });

  it("asking the same question in two channels", () => {
    const sends = ["help", "general"].map((c) => say("does anyone know why my mic is so quiet", { conversationId: c }));
    for (const s of everySensitivity) assert.equal(firstTrip(sends, { sensitivity: s }), 0, s);
  });

  it("a new member saying hello twice by accident", () => {
    const sends = [say("hello everyone, nice to be here"), say("hello everyone, nice to be here")];
    for (const s of everySensitivity) {
      assert.equal(firstTrip(sends, { sender: newcomer, gapMs: 300, sensitivity: s }), 0, s);
    }
  });

  it("a photo dump in two big messages", () => {
    const sends = [say("from the trip", { attachments: 10 }), say("", { attachments: 10 }), say("the last one is my favourite")];
    for (const s of everySensitivity) assert.equal(firstTrip(sends, { sensitivity: s }), 0, s);
  });

  it("a busy group DM", () => {
    const group = ["user_a", "user_b", "user_c", "user_d", "user_e", "user_f"];
    const sends = repeat(30, (i) => dm("group_1", "", { recipients: group, newConversation: i === 0, size: 60 + (i % 5) * 11 }));
    for (const s of everySensitivity) {
      assert.equal(firstTrip(sends, { sender: newcomer, gapMs: 2_000, sensitivity: s }), 0, s);
    }
  });

  it("messaging a few friends the same invite to game night", () => {
    const sends = repeat(4, (i) => dm(`dm_${i}`, `friend_${i}`, { newConversation: false, size: 64 }));
    for (const s of everySensitivity) assert.equal(firstTrip(sends, { gapMs: 20_000, sensitivity: s }), 0, s);
  });
});

describe("after a trip", () => {
  it("starts clean, so the burst that earned one timeout does not earn the next", () => {
    const filter = new SpamFilter();
    let tripped = -1;
    for (let i = 0; i < 6 && tripped < 0; i++) {
      if (filter.evaluate(regular, say("buy cheap followers at my site"), "normal", T0 + i * 1_000).spam) tripped = i;
    }
    assert.equal(tripped, 3);
    const after = filter.evaluate(regular, say("sorry, that was a bot on my account"), "normal", T0 + 70_000);
    assert.equal(after.spam, false);
    assert.equal(after.score, 0);
  });

  it("names every signal that scored", () => {
    const filter = new SpamFilter();
    let verdict = filter.evaluate(regular, say("x"), "normal", T0);
    for (let i = 0; i < 4; i++) {
      verdict = filter.evaluate(
        regular,
        say("@everyone join discord.gg/abcdef now", { conversationId: `c${i}`, massMentions: 1 }),
        "normal",
        T0 + (i + 1) * 1_000,
      );
      if (verdict.spam) break;
    }
    assert.equal(verdict.spam, true);
    const names = verdict.signals.map((s) => s.name).sort();
    assert.deepEqual(names, ["cross_channel", "duplicate", "invites", "mentions"]);
  });
});

describe("exemptions and escalation", () => {
  const perms = (...p: Permission[]) => new Set<Permission>(p);

  it("exempts the owner, moderators, admins and bots, and nobody else", () => {
    assert.equal(isSpamExempt({ isOwner: true, permissions: perms(), grytUserId: "acct" }), true);
    for (const p of ["kick_members", "ban_members", "mute_members", "manage_messages", "manage_roles", "manage_server"] as Permission[]) {
      assert.equal(isSpamExempt({ isOwner: false, permissions: perms(p), grytUserId: "acct" }), true, p);
    }
    assert.equal(isSpamExempt({ isOwner: false, permissions: perms(), grytUserId: "BOT_helper" }), true);
    assert.equal(
      isSpamExempt({ isOwner: false, permissions: perms("send_messages", "mention_everyone", "view_audit_log"), grytUserId: "acct" }),
      false,
    );
  });

  it("climbs 1 minute, 10 minutes, an hour, a day, and stays there", () => {
    assert.deepEqual([0, 1, 2, 3, 4, 9].map(timeoutMinutesFor), [1, 10, 60, 1440, 1440, 1440]);
  });

  it("reads an unknown sensitivity as normal", () => {
    assert.equal(normalizeSpamSensitivity("HIGH"), "normal");
    assert.equal(normalizeSpamSensitivity(undefined), "normal");
    assert.equal(normalizeSpamSensitivity("low"), "low");
  });
});
