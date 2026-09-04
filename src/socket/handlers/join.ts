import consola from "consola";
import type { HandlerContext, EventHandlerMap } from "./types";
import { applyInviteRole } from "../../services/inviteRoles";
import { syncAllClients, broadcastMemberList, countOtherSessions, verifyClient } from "../utils/clients";
import { sendServerDetails } from "../utils/server";
import { remindOutdatedWindowsClient } from "../utils/outdatedClient";
import { postSystemMessage, formatJoinMessage } from "../utils/systemMessages";
import { createChallenge, consumeChallenge, verifyCertificate, verifyAssertion, verifyIdentityLink, identityTierAccepted, identityTierOf, IdentityVerificationError, type BotDeclaration, type IdentityTier, looksLikeABotName } from "../../auth/identity";
import { normalizePermissions } from "../../constants/permissions";
import { defaultRoleForTier } from "../../services/permissions";
import { broadcastServerUiUpdate } from "../utils/server";
import { applyAutoRoles } from "../../services/autoRoles";
import { readServiceState, serviceStateVarName } from "../../config/serviceState";
import { generateAccessToken, generateFileToken, TokenPayload } from "../../utils/jwt";
import {
  getServerConfig,
  createServerConfigIfNotExists,
  claimServerOwner,
  getUserByGrytId,
  carryIdentityForward,
  upsertUser,
  consumeServerInvite,
  listMemberRoles,
  addMemberRole,
  setServerRole,
  createRefreshToken,
  effectiveModerationState,
  normalizeJoinPolicy,
  createOrRefreshJoinRequest,
  clearJoinRequest,
  getBotById,
  claimBotRegistration,
  recordBotKnock,
  insertServerAudit,
} from "../../db";
import type { BotRecord } from "../../db";
import { isPrivateIp } from "../../utils/isPrivateIp";
import { checkIdentityAllowed } from "../../moderation/sessionGate";
import { checkRateLimit, RateLimitRule } from "../../utils/rateLimiter";
import {
  registerJoinHelpers,
  applyInviteFailure,
  applyInviteIpFailure,
  clearInviteCooldown,
  clearInviteIpCooldown,
  getInviteCooldownKey,
  getInviteCooldownState,
  getInviteIpCooldownState,
} from "./joinHelpers";

// ── Rate limit rules ────────────────────────────────────────────────

const RL_JOIN: RateLimitRule = {
  limit: 20, windowMs: 60_000, banMs: 60_000,
  scorePerAction: 0.5, maxScore: 10, scoreDecayMs: 5000,
};

/**
 * How often one address may ask to be let in. The queue is keyed on identity,
 * which does not bound a script minting a fresh local identity per attempt.
 */
const RL_JOIN_REQUEST: RateLimitRule = {
  limit: 10, windowMs: 60 * 60_000, banMs: 10 * 60_000,
  scorePerAction: 1, maxScore: 10, scoreDecayMs: 60_000,
};

/**
 * How many people one invite may bring in per hour. `RL_JOIN` is keyed on IP
 * and scales straight up with the number of addresses, so once a link is
 * public the invite itself is the only thing left to limit.
 *
 * A sliding window, so thirty people joining a LAN party in one minute all get
 * in. A server running a bigger event raises it.
 */
function inviteArrivalRule(): RateLimitRule {
  const raw = parseInt(process.env.GRYT_INVITE_MAX_JOINS_PER_HOUR || "", 10);
  const limit = Number.isFinite(raw) && raw > 0 ? raw : 60;
  return { limit, windowMs: 3_600_000 };
}


/** Once per process: a server in this state hits it on every connection. */
let warnedLanOpenBehindProxy = false;
function warnLanOpenBehindProxy(ip: string): void {
  if (warnedLanOpenBehindProxy) return;
  warnedLanOpenBehindProxy = true;
  consola.warn(
    `"Allow anyone on LAN to join" is on, but this request arrived through a ` +
      `proxy and GRYT_TRUSTED_PROXY_HOPS is 0, so the address available here ` +
      `(${ip}) belongs to the proxy rather than to the client. Treating that ` +
      `as a local address would let anybody who can reach the proxy join ` +
      `without an invite, so the invite requirement still applies. Set ` +
      `GRYT_TRUSTED_PROXY_HOPS to the number of proxies in front of this ` +
      `server to make LAN open join work as intended.`
  );
}

// ── Handlers ────────────────────────────────────────────────────────


/**
 * "This member is a bot, so there is no role to assign". A throw rather than a
 * flag because the block it skips sits inside a try that swallows and logs.
 */
class BotHoldsNoRole extends Error {}

/**
 * Whether a bot is allowed in, and under which registration. Only an
 * already-approved bot gets in, and what it declares this time is ignored
 * entirely — a bot whose image has been taken over cannot change the question
 * after it has been answered.
 */
async function admitBot(
  botId: string,
  declaration: BotDeclaration | undefined,
  declaredName: string,
): Promise<
  | { ok: true; bot: BotRecord }
  | { ok: false; error: string; message: string; canReapply: boolean }
> {
  const existing = await getBotById(botId);

  if (existing) {
    if (existing.status === "approved") return { ok: true, bot: existing };
    if (existing.status === "denied") {
      // Told the same thing as a pending bot, for the same reason the human
      // join-request path gives: confirming that somebody looked and said no
      // invites arguing with the message rather than with a person.
      return {
        ok: false,
        error: "bot_not_approved",
        message: "This bot is waiting to be approved by a server admin.",
        canReapply: true,
      };
    }
    return {
      ok: false,
      error: "bot_not_approved",
      message: "This bot is waiting to be approved by a server admin.",
      canReapply: true,
    };
  }

  const claimToken = declaration?.claimToken?.trim();
  if (claimToken) {
    const claimed = await claimBotRegistration(claimToken, botId);
    if (claimed) return { ok: true, bot: claimed };
    return {
      ok: false,
      error: "bot_token_invalid",
      message: "That bot token is not valid, or has already been used by another bot.",
      canReapply: false,
    };
  }

  const cfg = await getServerConfig().catch(() => null);
  if (cfg?.bot_join_policy !== "request") {
    return {
      ok: false,
      error: "bot_join_disabled",
      message: "This server does not accept bots that have not been set up by an admin.",
      canReapply: false,
    };
  }

  const { bot, created } = await recordBotKnock({
    botId,
    nickname: declaredName,
    description: declaration?.description ?? null,
    requestedPermissions: normalizePermissions(declaration?.permissions ?? []),
  });

  if (created) {
    insertServerAudit({
      actorServerUserId: null,
      action: "bot_knocked",
      target: botId,
      meta: { nickname: bot.nickname, requested: bot.requested_permissions },
    }).catch((e: unknown) => consola.warn("audit log write failed", e));
    broadcastServerUiUpdate();
  }

  return {
    ok: false,
    error: "bot_not_approved",
    message: "This bot is waiting to be approved by a server admin.",
    canReapply: true,
  };
}

export function registerJoinHandlers(ctx: HandlerContext): EventHandlerMap {
  const { io, socket, clientId, serverId, clientsInfo, getClientIp, clientAddressIsOwn } = ctx;

  const helpers = registerJoinHelpers(ctx);

  return {
    ...helpers,

    // Step 1: Client requests to join. Server validates basic pre-conditions
    // and responds with a cryptographic challenge.
    'server:join': async (payload: {
      nickname?: string;
      inviteCode?: string;
      bot?: { permissions?: unknown; description?: unknown; claimToken?: unknown };
    }) => {
      try {
        const ip = getClientIp();
        const rl = checkRateLimit("server:join", undefined, ip, RL_JOIN);
        if (!rl.allowed) {
          socket.emit("server:error", {
            error: "rate_limited",
            retryAfterMs: rl.retryAfterMs,
            message: `Too fast. Wait ${Math.ceil((rl.retryAfterMs || 0) / 1000)}s.`,
          });
          return;
        }

        const service = readServiceState();
        if (!service.inService) {
          if ("misconfigured" in service) {
            socket.emit("server:error", {
              error: "auth_misconfigured",
              message: `Unsupported ${serviceStateVarName()} "${service.misconfigured}".`,
            });
            return;
          }
          // Wording kept as it was rather than corrected to "out of service".
          // The client matches on the `error` code, not the sentence, but this
          // one reaches a person, and changing both the code and the copy in the
          // same release would leave nothing recognisable in a bug report.
          socket.emit("server:error", { error: "auth_disabled", message: "This server has disabled authentication." });
          return;
        }

        const nickname = (payload?.nickname || "User").trim();
        if (nickname.length > 50) {
          socket.emit("server:error", { error: "invalid_nickname", message: "Nickname too long (max 50)." });
          return;
        }

        const serverHost = socket.handshake.headers.host || "unknown";
        const inviteCode = typeof payload?.inviteCode === "string" ? payload.inviteCode.trim() : undefined;

        // Everything here is attacker-supplied and ends up in front of an
        // operator, so it is bounded on the way in and never rendered as markup.
        const botDeclaration = payload?.bot
          ? {
              permissions: Array.isArray(payload.bot.permissions)
                ? payload.bot.permissions.filter((p): p is string => typeof p === "string").slice(0, 64)
                : [],
              description:
                typeof payload.bot.description === "string" ? payload.bot.description : undefined,
              claimToken:
                typeof payload.bot.claimToken === "string" ? payload.bot.claimToken : undefined,
            }
          : undefined;

        const challenge = createChallenge(socket.id, serverHost, nickname, inviteCode, botDeclaration);
        socket.emit("server:challenge", challenge);
      } catch (err) {
        consola.error("server:join failed", err);
        socket.emit("server:error", { error: "join_failed", message: "Failed to initiate join." });
      }
    },

    // Step 2: the client answers the challenge with a signed assertion and a
    // certificate. `note` rides here rather than on the challenge because the
    // challenge binds only what the client must not change between the two
    // steps, and nothing downstream trusts a note.
    'server:verify': async (payload: {
      certificate?: string;
      assertion?: string;
      link?: string;
      note?: string;
    }) => {
      try {
        const joinNote = typeof payload?.note === "string" ? payload.note : null;
        const challenge = consumeChallenge(socket.id);
        if (!challenge) {
          socket.emit("server:error", {
            error: "challenge_expired",
            message: "Challenge expired or not found. Please try joining again.",
            canReapply: true,
          });
          return;
        }

        if (!payload?.certificate || typeof payload.certificate !== "string") {
          socket.emit("server:error", {
            error: "auth_required",
            message: "Identity certificate is required. Please sign in.",
            canReapply: true,
          });
          return;
        }

        if (!payload?.assertion || typeof payload.assertion !== "string") {
          socket.emit("server:error", {
            error: "auth_required",
            message: "Signed assertion is required.",
            canReapply: true,
          });
          return;
        }

        let grytUserId: string;
        let suggestedNickname: string | undefined;
        let identityTier: IdentityTier;
        // The local identity this person used here before making an account,
        // if they proved they still hold its key.
        let priorSub: string | null = null;

        try {
          const cert = await verifyCertificate(payload.certificate);
          const assertionResult = await verifyAssertion(
            payload.assertion,
            cert.jwk,
            challenge.serverHost,
            challenge.nonce,
          );

          if (assertionResult.sub !== cert.sub) {
            throw new Error("Assertion subject does not match certificate subject");
          }

          // `grytUserId`, not `sub`: they differ for an account vouched for by
          // a secondary issuer, and this is what every table keys on, so a CA
          // trusted for its own users cannot name somebody else's (GRYT-267).
          grytUserId = cert.grytUserId;
          suggestedNickname = cert.preferredUsername;
          identityTier = cert.tier;

          // Only an account can claim a prior identity, and only ever a local
          // one. Letting a local identity claim another would make swapping
          // between them a matter of holding two keys, which is not a thing
          // anybody needs and is a way to shed a ban.
          if (payload.link && cert.tier === "account") {
            const link = await verifyIdentityLink(
              payload.link,
              challenge.serverHost,
              challenge.nonce,
              cert.sub,
            );
            priorSub = link.priorSub;
          }
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          consola.warn(`Identity verification failed for ${clientId}:`, message);

          // Which half failed, so a client whose certificate and signing key
          // have drifted apart can renew and retry. "Sign in again" sent people
          // to do the one thing that cannot help.
          const reason =
            e instanceof IdentityVerificationError ? e.reason : "unknown";
          // Only set when the verifier could tell that the clock was the
          // problem. Positive means their clock is behind this server's.
          const skewMs =
            e instanceof IdentityVerificationError ? e.skewMs : undefined;

          socket.emit("server:error", {
            error: "identity_verification_failed",
            reason,
            ...(skewMs === undefined ? {} : { skewMs }),
            message:
              reason === "nonce_mismatch"
                ? "This join attempt expired before it completed. Try again."
                : "The server could not verify your identity.",
            canReapply: true,
          });
          return;
        }

        // Whether the operator admits this kind of identity at all. Unlike the
        // ban refusal below this says exactly what is wrong, and leaks nothing:
        // the accepted tiers are already in `server:info`.
        //
        // Bots come from the registry, not GRYT_IDENTITY_TIERS. Otherwise
        // adding one bot means accepting every anonymous joiner, and a restart.
        let botRegistration: Awaited<ReturnType<typeof getBotById>> = null;
        if (identityTier === "bot") {
          const outcome = await admitBot(
            grytUserId,
            challenge.bot,
            // The name it asked to be called, used only if this is the first
            // time anybody has seen it. Once approved, the registration's name
            // is the one that sticks.
            (challenge.nickname || "Bot").trim(),
          );
          if (!outcome.ok) {
            consola.info(`Bot join refused for ${grytUserId}: ${outcome.error}`);
            socket.emit("server:error", {
              error: outcome.error,
              message: outcome.message,
              canReapply: outcome.canReapply,
            });
            return;
          }
          botRegistration = outcome.bot;
        } else if (!identityTierAccepted(identityTier)) {
          consola.info(`Join refused for ${grytUserId}: tier "${identityTier}" not accepted`);
          socket.emit("server:error", {
            error: "identity_tier_refused",
            tier: identityTier,
            message: "This server requires a Gryt account to join.",
          });
          return;
        }

        // A bot's name is whatever the operator approved, not what the bot sent
        // this time. It is the label people will use to decide whether to trust
        // a message, so it must not be something the bot can change after the
        // fact.
        const nickname = botRegistration
          ? botRegistration.nickname
          : (challenge.nickname || suggestedNickname || "User").trim();

        // A person must not be able to take a bot-shaped name. The badge comes
        // from the identity, so the trick is only on whoever reads quickly.
        if (!botRegistration && looksLikeABotName(nickname)) {
          socket.emit("server:error", {
            error: "nickname_reserved",
            message: 'Names that start with "bot" are reserved. Pick another.',
            canReapply: true,
          });
          return;
        }
        let cfg = await getServerConfig().catch(() => null);

        // Stays ahead of invite consumption so a banned user does not burn a
        // code on a join that was never going to succeed. The refusal is
        // deliberately uninformative; the real reason is in the audit log.
        const identity = await checkIdentityAllowed(grytUserId);
        if (!identity.ok) {
          consola.info(`Join refused for ${grytUserId}: ${identity.code}`);
          socket.emit("server:error", {
            error: "join_refused",
            message: "Sorry, you can't join this server.",
          });
          return;
        }

        // A ban follows the identity being claimed, not just the one presented.
        // Without this, making an account is the cheapest ban evasion there is:
        // get banned without one, sign up, arrive with a clean sub and link the
        // old identity back on afterwards.
        if (priorSub) {
          const prior = await checkIdentityAllowed(priorSub);
          if (!prior.ok) {
            consola.info(`Join refused for ${grytUserId}: linked identity ${priorSub} is ${prior.code}`);
            socket.emit("server:error", {
              error: "join_refused",
              message: "Sorry, you can't join this server.",
            });
            return;
          }
        }

        // Carry the old membership over before anything reads it, so the join
        // continues as the member they already were — with their roles, and
        // owning what they owned.
        if (priorSub) {
          try {
            const carry = await carryIdentityForward(priorSub, grytUserId);
            if (carry.status === "carried") {
              consola.info(`Linked ${priorSub} to ${grytUserId} on join`);
              // `cfg` was read before the carry-over, which is the one thing
              // here that can change who owns the server. Stale, it sends
              // `isOwner: false` to somebody who does own it.
              cfg = await getServerConfig().catch(() => cfg);
            } else if (carry.status === "account_already_member") {
              // Both identities are already members, so nothing moves and
              // nobody is told. This line is what answers "where did my roles
              // go" afterwards.
              consola.info(
                `Not linking ${priorSub} to ${grytUserId}: both are members here, so the guest membership was left as it is`,
              );
            }
          } catch (e) {
            // Not fatal. The join is still legitimate on its own terms, and a
            // failed carry-over leaves them a new member rather than shut out.
            consola.warn("Identity carry-over failed:", e);
          }
        }

        const existingMember = await getUserByGrytId(grytUserId);
        const isActiveMember = !!(existingMember && existingMember.is_active);
        let claimedOwnerGrytUserId: string | null | undefined;
        let usedInviteCode: string | undefined;

        // Bots skip the invite and join-policy gate, and have to: their
        // admission *is* the registration. Requiring an invite too means an
        // approved bot cannot join a server on the default policy.
        if (!isActiveMember && !botRegistration) {
          const ip = getClientIp();
          const inviteKey = getInviteCooldownKey(ip, grytUserId);
          const now = Date.now();
          const inviteState = getInviteCooldownState(inviteKey, now);
          const ipState = getInviteIpCooldownState(ip, now);
          const inviteLocked = !!(inviteState.cooldownUntilMs && now < inviteState.cooldownUntilMs);
          const ipLocked = !!(ipState.cooldownUntilMs && now < ipState.cooldownUntilMs);
          if (inviteLocked || ipLocked) {
            const retryAfterMs = Math.max(
              inviteLocked ? inviteState.cooldownUntilMs - now : 0,
              ipLocked ? ipState.cooldownUntilMs - now : 0,
            );
            socket.emit("server:error", {
              error: "invite_rate_limited",
              message: "Too many incorrect invite attempts. Please wait.",
              retryAfterMs: Math.max(0, retryAfterMs),
              canReapply: true,
            });
            return;
          }

          const inviteCode = challenge.inviteCode || "";
          if (inviteCode) {
            // Checked before consuming, so a refused arrival does not spend a
            // use of a limited invite. Keyed on the code rather than the
            // caller, which is the point: the limit has to hold across every
            // machine holding the same link.
            const arrivals = checkRateLimit("invite:arrivals", inviteCode, undefined, inviteArrivalRule());
            if (!arrivals.allowed) {
              consola.warn(`Invite ${inviteCode} hit its hourly arrival limit`);
              socket.emit("server:error", {
                error: "invite_rate_limited",
                message: "This invite has been used too many times recently. Try again later.",
                retryAfterMs: arrivals.retryAfterMs,
                canReapply: true,
              });
              return;
            }

            const consumed = await consumeServerInvite(inviteCode);
            if (!consumed.ok) {
              const msg =
                consumed.reason === "expired" ? "That invite code has expired."
                  : consumed.reason === "revoked" ? "That invite code has been revoked."
                    : consumed.reason === "used_up" ? "No uses remaining."
                      : "Invalid invite code.";
              const lock = applyInviteFailure(inviteKey);
              const ipLock = applyInviteIpFailure(ip);
              const isLocked = lock.locked || ipLock.locked;
              const retryAfterMs = Math.max(lock.retryAfterMs, ipLock.retryAfterMs);
              socket.emit("server:error", {
                error: isLocked ? "invite_rate_limited" : "invalid_invite",
                message: isLocked ? "Too many incorrect invite attempts. Please wait." : msg,
                retryAfterMs: isLocked ? (retryAfterMs || undefined) : undefined,
                canReapply: true,
              });
              return;
            }
            usedInviteCode = inviteCode;
            clearInviteCooldown(inviteKey);
            clearInviteIpCooldown(ip);
          } else if (cfg?.lan_open && isPrivateIp(ip) && clientAddressIsOwn()) {
            clearInviteCooldown(inviteKey);
            clearInviteIpCooldown(ip);
          } else {
            if (cfg?.lan_open && isPrivateIp(ip) && !clientAddressIsOwn()) {
              warnLanOpenBehindProxy(ip);
            }
            // Ahead of the policy check, and has to be: the first person
            // through the door arrives without an invite, and claiming after
            // would leave the server ownerless and unconfigurable.
            const claimed = await claimServerOwner(grytUserId);
            claimedOwnerGrytUserId = claimed.owner;
            const policy = normalizeJoinPolicy(cfg?.join_policy);
            const isClaimingOwner = claimedOwnerGrytUserId === grytUserId;

            if (!isClaimingOwner && policy === "request") {
              // Asking is rate limited per address, not per identity. The row is
              // keyed on the identity, so one person cannot build a queue on
              // their own — but a script making a fresh local identity each time
              // can, and each one costs nothing to make.
              const asks = checkRateLimit("join:requests", undefined, ip, RL_JOIN_REQUEST);
              if (!asks.allowed) {
                socket.emit("server:error", {
                  error: "rate_limited",
                  message: "Too many requests to join. Please wait.",
                  retryAfterMs: asks.retryAfterMs,
                  canReapply: true,
                });
                return;
              }

              const request = await createOrRefreshJoinRequest(grytUserId, nickname, joinNote);

              if (request.status === "approved") {
                // Let them through, and take the row with them. Leaving it would
                // mean an approval readmits them forever, including after they
                // leave or are removed.
                await clearJoinRequest(grytUserId);
                consola.info(`Approved join request used by ${grytUserId}`);
              } else {
                // A denial is told the same thing as a pending one. Saying "you
                // were turned down" confirms a moderator looked and decided,
                // which is the same leak the ban refusal above avoids — and it
                // invites arguing with the message instead of with a person.
                consola.info(`Join request ${request.status} for ${grytUserId}`);
                socket.emit("server:error", {
                  error: "approval_pending",
                  message: "This server admits people by request. Yours is with the moderators.",
                  canReapply: true,
                });
                return;
              }
            } else if (!isClaimingOwner && policy !== "open") {
              socket.emit("server:error", {
                error: "invite_required",
                message: "Invite required to join this server.",
                canReapply: true,
              });
              return;
            }
            clearInviteCooldown(inviteKey);
            clearInviteIpCooldown(ip);
          }
        }

        if (!cfg) {
          const created = await createServerConfigIfNotExists({
            displayName: process.env.SERVER_NAME || undefined,
            description: process.env.SERVER_DESCRIPTION || undefined,
          });
          cfg = created.config;
        }

        const user = await upsertUser(grytUserId, nickname.trim(), {
          inviteCode: usedInviteCode,
        });
        const isOwner = ((claimedOwnerGrytUserId ?? cfg?.owner_gryt_user_id) || null) === grytUserId;
        const setupRequired = isOwner && !cfg?.is_configured;
        const tokenVersion = cfg?.token_version ?? 0;

        // Deliberately skipped for a bot: no roles row, and no auto-role pass.
        // A bot's permissions live on its registration, and a roles row would be
        // a second place that could disagree with it — including one that a role
        // edit could quietly widen.
        try {
          if (botRegistration) throw new BotHoldsNoRole();
          const existingRoles = await listMemberRoles(user.server_user_id);
          // A first-time joiner lands on the default for their identity tier —
          // which is how "guests may read, accounts may talk" is expressed. An
          // existing member keeps whatever they were given; changing the
          // default must not re-sort the people already here.
          const joinRole = defaultRoleForTier(identityTierOf(grytUserId), cfg);
          if (existingRoles.length === 0) {
            await setServerRole(user.server_user_id, isOwner ? "owner" : joinRole);
            // A role bound to the invite, if it still passes the rules. Only
            // reachable on a first join, never on a reconnect carrying the same
            // stored code. Added rather than assigned, so an invite can raise
            // somebody above the tier default and never below it.
            if (!isOwner && usedInviteCode) {
              await applyInviteRole(usedInviteCode, user.server_user_id);
            }
          } else if (isOwner && !existingRoles.includes("owner")) {
            // Added rather than assigned. The owner is allowed to hold other
            // roles, and replacing the set here would take them away every time
            // they reconnected.
            await addMemberRole(user.server_user_id, "owner");
          }

          // A role they earned while they were away lands now. Joining is one
          // of the two moments the answer can change — the other is sending a
          // message — and doing it here rather than on a timer means there is
          // no background job to fail quietly.
          await applyAutoRoles(user.server_user_id, grytUserId);
        } catch (e) {
          if (!(e instanceof BotHoldsNoRole)) consola.warn("Failed to ensure role row:", e);
        }

        const tokenPayload: TokenPayload = {
          grytUserId: user.gryt_user_id,
          serverUserId: user.server_user_id,
          nickname: user.nickname,
          serverHost: socket.handshake.headers.host || "unknown",
          tokenVersion,
        };

        const accessToken = generateAccessToken(tokenPayload);
        // Reads uploads and nothing else. It goes in the query string of an
        // `<img src>`, where an Authorization header cannot follow, so it is
        // deliberately the weaker of the two. See GRYT-740.
        const fileToken = generateFileToken(tokenPayload);

        const refreshTokenRecord = await createRefreshToken({
          grytUserId: user.gryt_user_id,
          serverUserId: user.server_user_id,
        });

        if (clientsInfo[clientId]) {
          clientsInfo[clientId].grytUserId = user.gryt_user_id;
          clientsInfo[clientId].serverUserId = user.server_user_id;
          clientsInfo[clientId].nickname = user.nickname;
          clientsInfo[clientId].accessToken = accessToken;

          // Carried on the user rather than the connection, so rejoining does
          // not clear a server mute.
          const moderation = effectiveModerationState(user);
          clientsInfo[clientId].isServerMuted = moderation.isServerMuted;
          clientsInfo[clientId].isServerDeafened = moderation.isServerDeafened;
        }

        await verifyClient(socket, clientsInfo);

        const otherCount = countOtherSessions(clientsInfo, clientId, user.gryt_user_id);
        if (otherCount > 0) {
          consola.info(`User ${user.nickname} now has ${otherCount + 1} concurrent sessions`);
        }

        socket.emit("server:joined", {
          accessToken,
          fileToken,
          refreshToken: refreshTokenRecord.token_id,
          nickname: user.nickname,
          avatarFileId: user.avatar_file_id || null,
          // What this server already holds for them, so a client knows on the
          // way in whether they have a look here rather than after the first
          // member list arrives.
          avatarWorn: user.avatar_worn ?? null,
          isOwner,
          setupRequired,
        });

        if (setupRequired) {
          socket.emit("server:setup_required", {
            serverId,
            settings: {
              displayName: cfg?.display_name || process.env.SERVER_NAME || "Unknown Server",
              description: cfg?.description || process.env.SERVER_DESCRIPTION || "A Gryt server",
              iconUrl: cfg?.icon_url || null,
              isConfigured: !!cfg?.is_configured,
            },
          });
        }

        try {
          sendServerDetails(socket, clientsInfo, serverId);
        } catch (e) {
          consola.error("Failed to send server details after join:", e);
        }
        syncAllClients(io, clientsInfo);
        broadcastMemberList(io, clientsInfo, serverId);
        if (!isActiveMember) {
          postSystemMessage(io, clientsInfo, formatJoinMessage(user.nickname, user.server_user_id));
        }

        // Outside the isActiveMember branch on purpose: someone who has been
        // a member for months is exactly who is stuck on a build that cannot
        // update, and they never join for the first time again.
        remindOutdatedWindowsClient(
          io,
          clientsInfo,
          socket.handshake.headers["user-agent"],
          user.server_user_id,
        );
      } catch (err) {
        consola.error("server:verify failed", err);
        socket.emit("server:error", { error: "join_failed", message: "Failed to join server." });
      }
    },
  };
}
