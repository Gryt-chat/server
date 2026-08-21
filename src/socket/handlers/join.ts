import consola from "consola";
import type { HandlerContext, EventHandlerMap } from "./types";
import { syncAllClients, broadcastMemberList, countOtherSessions, verifyClient } from "../utils/clients";
import { sendServerDetails } from "../utils/server";
import { postSystemMessage, formatJoinMessage } from "../utils/systemMessages";
import { createChallenge, consumeChallenge, verifyCertificate, verifyAssertion, verifyIdentityLink, identityTierAccepted, identityTierOf, IdentityVerificationError, type IdentityTier } from "../../auth/identity";
import { defaultRoleForTier } from "../../services/permissions";
import { readServiceState, serviceStateVarName } from "../../config/serviceState";
import { generateAccessToken, TokenPayload } from "../../utils/jwt";
import {
  getServerConfig,
  createServerConfigIfNotExists,
  claimServerOwner,
  getUserByGrytId,
  carryIdentityForward,
  upsertUser,
  consumeServerInvite,
  getServerRole,
  setServerRole,
  createRefreshToken,
  effectiveModerationState,
  normalizeJoinPolicy,
  createOrRefreshJoinRequest,
  clearJoinRequest,
} from "../../db";
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
 * How often one address may ask to be let in.
 *
 * The queue is keyed on identity, so nobody builds a backlog on their own by
 * asking twice. What that does not bound is a script minting a fresh local
 * identity per attempt — those cost nothing to make, and each one is a new row
 * and a new line in somebody's moderation queue. Ten an hour is far more than a
 * person needs and far less than a queue-flooder wants.
 */
const RL_JOIN_REQUEST: RateLimitRule = {
  limit: 10, windowMs: 60 * 60_000, banMs: 10 * 60_000,
  scorePerAction: 1, maxScore: 10, scoreDecayMs: 60_000,
};

/**
 * How many people one invite may bring in per hour.
 *
 * `RL_JOIN` above is keyed on IP, which bounds one machine and nothing else —
 * measured at 19 arrivals in 47ms from a single address before it bit, and it
 * scales straight up with the number of addresses. An invite link is meant to
 * be shared, so once it is public the only thing left to limit is the invite
 * itself.
 *
 * Sixty an hour, as a sliding window, so it is a burst allowance rather than a
 * trickle: thirty people joining a LAN party in the same minute all get in,
 * which is the case invites exist for. What it stops is the same link admitting
 * thousands unattended.
 *
 * A server running an event bigger than this raises it. That is a better
 * default than picking a number nobody can exceed, because the cost of being
 * too tight is somebody's party not working and the cost of being too loose is
 * a cleanup job.
 */
function inviteArrivalRule(): RateLimitRule {
  const raw = parseInt(process.env.GRYT_INVITE_MAX_JOINS_PER_HOUR || "", 10);
  const limit = Number.isFinite(raw) && raw > 0 ? raw : 60;
  return { limit, windowMs: 3_600_000 };
}


/**
 * Said once per process, not once per join, because a server in this state
 * hits it on every single connection and a log that scrolls is a log nobody
 * reads.
 */
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

        const challenge = createChallenge(socket.id, serverHost, nickname, inviteCode);
        socket.emit("server:challenge", challenge);
      } catch (err) {
        consola.error("server:join failed", err);
        socket.emit("server:error", { error: "join_failed", message: "Failed to initiate join." });
      }
    },

    // Step 2: Client responds to the challenge with a signed assertion
    // and an identity certificate. Server verifies both and completes the join.
    // `note` rides here rather than on the challenge deliberately. The
    // challenge binds what the client must not be able to change between the
    // two steps — the nickname it will be admitted under, the invite it claimed.
    // A note is a message to a moderator; nothing downstream trusts it, so
    // binding it would mean widening the challenge for no property gained.
    // The client knows to ask for one because `/info` publishes `joinPolicy`.
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

          // `grytUserId`, not `sub`. The two differ for an account vouched for
          // by anything other than the primary issuer, and this is the value
          // every table keys on — so a CA that is trusted for its own users
          // cannot name somebody else's (GRYT-267). The checks above and the
          // link below stay on `sub`, which is what the client signed and the
          // only value it knows.
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

          // The detail stays in the log. What goes to the client is which half
          // failed, which is enough for it to act: a rejected assertion usually
          // means its certificate and signing key have drifted apart, and it can
          // renew and retry without troubling anyone. Telling it only
          // "sign in again" sent people to do the one thing that cannot help.
          const reason =
            e instanceof IdentityVerificationError ? e.reason : "unknown";

          socket.emit("server:error", {
            error: "identity_verification_failed",
            reason,
            message:
              reason === "nonce_mismatch"
                ? "This join attempt expired before it completed. Try again."
                : "The server could not verify your identity.",
            canReapply: true,
          });
          return;
        }

        // Real, and then wanted. The certificate verified, so this is genuinely
        // whoever it says it is — this asks whether the operator admits that
        // kind of identity at all.
        //
        // Unlike the ban refusal below, this one says exactly what is wrong.
        // Nothing leaks: the accepted tiers are already advertised in
        // `server:info` before anyone tries, and somebody turned away for
        // having no account can only act on it if they are told so.
        if (!identityTierAccepted(identityTier)) {
          consola.info(`Join refused for ${grytUserId}: tier "${identityTier}" not accepted`);
          socket.emit("server:error", {
            error: "identity_tier_refused",
            tier: identityTier,
            message: "This server requires a Gryt account to join.",
          });
          return;
        }

        const nickname = (challenge.nickname || suggestedNickname || "User").trim();
        let cfg = await getServerConfig().catch(() => null);

        // Stays ahead of invite consumption so a banned user does not burn an
        // invite code on a join that was never going to succeed.
        //
        // The refusal is deliberately uninformative. Telling somebody they are
        // banned confirms both that the ban exists and that this identity is
        // known here, which is a moderation decision leaking to the person it
        // was made about — and it invites arguing with the message rather than
        // with a moderator. The real reason is in the audit log, and the
        // moderator who acted already told them if they wanted to.
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
              // `cfg` was read before the carry-over, and the carry-over is the
              // one thing in this handler that can change who owns the server.
              // Leaving it stale sends `isOwner: false` to somebody who owns
              // the server in the database — no owner UI until they rejoin,
              // which is the exact case this feature exists to fix.
              cfg = await getServerConfig().catch(() => cfg);
            } else if (carry.status === "account_already_member") {
              // Both identities are members here, so nothing moves and the
              // guest membership stays behind with whatever it holds. Worth a
              // line: it is the one outcome where somebody asked to bring an
              // identity across, was refused for a good reason, and is told
              // nothing. Somebody reading the log after "where did my roles
              // go" needs to find this.
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

        if (!isActiveMember) {
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
            // The claim stays ahead of the policy check, and has to. It is what
            // makes the first person through the door the owner, and on an open
            // server that person arrives without an invite like everybody else
            // — admitting them before claiming would leave the server ownerless
            // and unconfigurable.
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

        try {
          const existingRole = await getServerRole(user.server_user_id);
          // A first-time joiner lands on the default for their identity tier —
          // which is how "guests may read, accounts may talk" is expressed. An
          // existing member keeps whatever they were given; changing the
          // default must not re-sort the people already here.
          const joinRole = defaultRoleForTier(identityTierOf(grytUserId), cfg);
          if (!existingRole) await setServerRole(user.server_user_id, isOwner ? "owner" : joinRole);
          else if (isOwner && existingRole !== "owner") await setServerRole(user.server_user_id, "owner");
        } catch (e) {
          consola.warn("Failed to ensure role row:", e);
        }

        const tokenPayload: TokenPayload = {
          grytUserId: user.gryt_user_id,
          serverUserId: user.server_user_id,
          nickname: user.nickname,
          serverHost: socket.handshake.headers.host || "unknown",
          tokenVersion,
        };

        const accessToken = generateAccessToken(tokenPayload);

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

        verifyClient(socket);

        const otherCount = countOtherSessions(clientsInfo, clientId, user.gryt_user_id);
        if (otherCount > 0) {
          consola.info(`User ${user.nickname} now has ${otherCount + 1} concurrent sessions`);
        }

        socket.emit("server:joined", {
          accessToken,
          refreshToken: refreshTokenRecord.token_id,
          nickname: user.nickname,
          avatarFileId: user.avatar_file_id || null,
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
      } catch (err) {
        consola.error("server:verify failed", err);
        socket.emit("server:error", { error: "join_failed", message: "Failed to join server." });
      }
    },
  };
}
