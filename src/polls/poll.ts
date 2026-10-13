/**
 * Polls (GRYT-1732): a message with a question and options people vote on. Stored on the
 * message as JSON, with each member's picks; what clients get is `publicPoll`'s view.
 */

export const POLL_QUESTION_MAX = 300;
export const POLL_OPTION_MAX = 100;
export const POLL_OPTIONS_MIN = 2;
export const POLL_OPTIONS_MAX = 10;
/** The longest a poll may run: a week. Never-ending polls have no end time at all. */
export const POLL_DURATION_MAX_S = 7 * 24 * 60 * 60;

export interface StoredPoll {
  question: string;
  options: string[];
  multi: boolean;
  /** Who voted for what is never sent; only totals and your own picks. */
  anonymous: boolean;
  ends_at: string | null;
  /** Only members holding one of these roles may answer. Null is everyone who can read it. */
  allowed_roles: string[] | null;
  /** Each member's picks by server user id, as option indexes. */
  votes: Record<string, number[]>;
}

export interface PublicPollOption {
  text: string;
  count: number;
  /** Server user ids, only on a poll that isn't anonymous. */
  voters?: string[];
}

export interface PublicPoll {
  question: string;
  options: PublicPollOption[];
  multi: boolean;
  anonymous: boolean;
  ends_at: string | null;
  allowed_roles: string[] | null;
  closed: boolean;
  /** How many people voted, not how many votes: on a multi-answer poll they differ. */
  voter_count: number;
  /** The viewer's own picks. Absent where the server doesn't know who's looking. */
  mine?: number[];
}

/** What each refusal tells the person who hit it. */
export const POLL_REFUSALS: Record<string, string> = {
  poll_question: `A poll needs a question of up to ${POLL_QUESTION_MAX} characters.`,
  poll_options: `A poll needs ${POLL_OPTIONS_MIN} to ${POLL_OPTIONS_MAX} options of up to ${POLL_OPTION_MAX} characters each.`,
  poll_options_repeat: "Two of the options are the same.",
  poll_duration: "A poll can run for one minute up to a week, or until it's closed.",
  poll_roles: "None of the roles picked for this poll exist any more.",
  poll_closed: "This poll has ended.",
  poll_not_allowed: "Your roles can't answer this poll.",
  poll_choice: "That isn't one of the options.",
  poll_missing: "That poll is gone.",
};

export type PollInput = { question?: unknown; options?: unknown; multi?: unknown; anonymous?: unknown; ends_in_seconds?: unknown; allowed_roles?: unknown };

/** A poll from a client's send, or why it was refused. */
export function parsePoll(input: PollInput, now = new Date()): StoredPoll | { error: string } {
  const question = typeof input.question === "string" ? input.question.trim() : "";
  if (!question || question.length > POLL_QUESTION_MAX) return { error: "poll_question" };
  if (!Array.isArray(input.options)) return { error: "poll_options" };
  const options = input.options.map((o) => (typeof o === "string" ? o.trim() : "")).filter(Boolean);
  if (options.length !== input.options.length) return { error: "poll_options" };
  if (options.length < POLL_OPTIONS_MIN || options.length > POLL_OPTIONS_MAX) return { error: "poll_options" };
  if (options.some((o) => o.length > POLL_OPTION_MAX)) return { error: "poll_options" };
  if (new Set(options.map((o) => o.toLowerCase())).size !== options.length) return { error: "poll_options_repeat" };
  let ends_at: string | null = null;
  if (input.ends_in_seconds != null) {
    const s = Number(input.ends_in_seconds);
    if (!Number.isFinite(s) || s < 60 || s > POLL_DURATION_MAX_S) return { error: "poll_duration" };
    ends_at = new Date(now.getTime() + Math.round(s) * 1000).toISOString();
  }
  let allowed_roles: string[] | null = null;
  if (input.allowed_roles != null) {
    if (!Array.isArray(input.allowed_roles) || input.allowed_roles.some((r) => typeof r !== "string" || !r)) return { error: "poll_roles" };
    const roles = [...new Set(input.allowed_roles as string[])];
    if (roles.length > 0) allowed_roles = roles;
  }
  return { question, options, multi: input.multi === true, anonymous: input.anonymous === true, ends_at, allowed_roles, votes: {} };
}

export function pollClosed(poll: StoredPoll, now = new Date()): boolean {
  return !!poll.ends_at && new Date(poll.ends_at).getTime() <= now.getTime();
}

/** Whether someone holding these roles may answer. */
export function mayAnswer(poll: StoredPoll, voterRoles: readonly string[]): boolean {
  return !poll.allowed_roles || poll.allowed_roles.some((r) => voterRoles.includes(r));
}

/** One member's new picks, replacing their old ones. An empty list takes their vote back. */
export function applyVote(poll: StoredPoll, voter: string, picks: unknown, now = new Date(), voterRoles: readonly string[] = []): StoredPoll | { error: string } {
  if (pollClosed(poll, now)) return { error: "poll_closed" };
  if (!mayAnswer(poll, voterRoles)) return { error: "poll_not_allowed" };
  if (!Array.isArray(picks) || picks.some((p) => !Number.isInteger(p) || p < 0 || p >= poll.options.length)) {
    return { error: "poll_choice" };
  }
  const unique = [...new Set(picks as number[])].sort((a, b) => a - b);
  if (!poll.multi && unique.length > 1) return { error: "poll_choice" };
  const votes = { ...poll.votes };
  if (unique.length === 0) delete votes[voter];
  else votes[voter] = unique;
  return { ...poll, votes };
}

/** What a client sees: totals, voters unless anonymous, and the viewer's own picks. */
export function publicPoll(poll: StoredPoll, viewer?: string, now = new Date()): PublicPoll {
  const options: PublicPollOption[] = poll.options.map((text) => ({ text, count: 0, ...(poll.anonymous ? {} : { voters: [] as string[] }) }));
  for (const [voter, picks] of Object.entries(poll.votes)) {
    for (const i of picks) {
      const option = options[i];
      if (!option) continue;
      option.count += 1;
      option.voters?.push(voter);
    }
  }
  return {
    question: poll.question,
    options,
    multi: poll.multi,
    anonymous: poll.anonymous,
    ends_at: poll.ends_at,
    allowed_roles: poll.allowed_roles ?? null,
    closed: pollClosed(poll, now),
    voter_count: Object.keys(poll.votes).length,
    ...(viewer !== undefined ? { mine: poll.votes[viewer] ?? [] } : {}),
  };
}

/** The text an app without polls shows instead. */
export function pollFallbackText(poll: StoredPoll): string {
  return `📊 ${poll.question}\n${poll.options.map((o) => `• ${o}`).join("\n")}\n(Update Gryt to vote in this poll.)`;
}

export function isStoredPoll(value: unknown): value is StoredPoll {
  return !!value && typeof value === "object" && "votes" in value && Array.isArray((value as StoredPoll).options);
}
