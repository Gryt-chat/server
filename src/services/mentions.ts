/**
 * `remarkMention.ts`'s rules restated, and the two have to agree exactly: a name
 * drawn as a mention that notified nobody looks like it worked.
 */

export interface MentionableMember {
  serverUserId: string;
  nickname: string;
}

/** The word-character test the client uses, kept identical on purpose. */
function isWordCharacter(character: string | undefined): boolean {
  return character !== undefined && /\w/.test(character);
}

/** Deduplicated, but ordered: naming somebody three times is one mention, and
    who a message addressed first is how a reader sorts a list. */
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
