/**
 * Who a message mentions.
 *
 * The client has decided what a mention is since before the server had an
 * opinion — `remarkMention.ts` matches `@nickname` against the live member
 * list and draws a span around it. This has to agree with that exactly, or the
 * two disagree about which words are highlighted and which ones reach somebody:
 * a name drawn as a mention that notified nobody is worse than no mentions at
 * all, because it looks like it worked.
 *
 * So the rules below are the client's rules, restated:
 *
 * - `@` followed by a nickname, compared case-insensitively
 * - not preceded by a word character, so `foo@ada` is an email, not a mention
 * - not followed by one, so `@ada` does not match inside `@adams`
 * - at the same position the longest nickname wins, so "Ada Lovelace" beats
 *   "Ada" when both are members
 * - scanning left to right, and the text after a match is not rescanned for
 *   the part already consumed
 *
 * Nicknames are resolved to ids here, at send time, on purpose. A nickname is
 * not stable — people rename themselves, and `nickname_change_count` exists
 * because of it — so a mention stored as text would follow the name rather
 * than the person, and start pointing at whoever took the name next.
 */

export interface MentionableMember {
  serverUserId: string;
  nickname: string;
}

/** The word-character test the client uses, kept identical on purpose. */
function isWordCharacter(character: string | undefined): boolean {
  return character !== undefined && /\w/.test(character);
}

/**
 * Every member the text mentions, in the order they are first mentioned.
 *
 * Deduplicated: naming somebody three times in one message is one mention. The
 * order is kept anyway, because "who did this message address first" is the
 * thing a reader would use to sort a list of them.
 */
export function findMentions(
  text: string,
  members: MentionableMember[],
): string[] {
  if (!text || members.length === 0) return [];

  // Longest first, so a member whose nickname contains another's is considered
  // before it. The client sorts the same way for the same reason.
  const sorted = [...members].sort((a, b) => b.nickname.length - a.nickname.length);

  const found: string[] = [];
  const seen = new Set<string>();
  let remaining = text;
  let consumed = 0;

  while (remaining.length > 0) {
    let earliest = -1;
    let matchedLength = 0;
    let matched: MentionableMember | null = null;

    for (const member of sorted) {
      const nickname = member.nickname;
      if (!nickname) continue;

      const index = remaining.toLowerCase().indexOf(`@${nickname.toLowerCase()}`);
      if (index === -1) continue;

      // A word character before the `@` means it is part of something else —
      // an email address, most often.
      if (index > 0 && isWordCharacter(remaining[index - 1])) continue;

      // And one after the name means the name is a prefix of a longer word.
      const after = index + 1 + nickname.length;
      if (after < remaining.length && isWordCharacter(remaining[after])) continue;

      const earlier = earliest === -1 || index < earliest;
      const longerAtSamePlace = index === earliest && nickname.length > matchedLength;
      if (earlier || longerAtSamePlace) {
        earliest = index;
        matchedLength = nickname.length;
        matched = member;
      }
    }

    if (earliest === -1 || !matched) break;

    if (!seen.has(matched.serverUserId)) {
      seen.add(matched.serverUserId);
      found.push(matched.serverUserId);
    }

    consumed = earliest + 1 + matchedLength;
    remaining = remaining.slice(consumed);
  }

  return found;
}
