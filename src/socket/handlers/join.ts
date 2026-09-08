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
import { pluginEvents } from "../../plugins";
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

/** Keyed on address, because the queue is keyed on identity and a script can
    mint a fresh local identity per attempt. */
const RL_JOIN_REQUEST: RateLimitRule = {
  limit: 10, windowMs: 60 * 60_000, banMs: 10 * 60_000,
  scorePerAction: 1, maxScore: 10, scoreDecayMs: 60_000,
};

/** `RL_JOIN` is keyed on IP, so once a link is public the invite is the only
    thing left to limit. Sliding, so a LAN party all gets in at once. */
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


/** A throw rather than a flag, because the block it skips sits inside a try
    that swallows and logs. */
class BotHoldsNoRole extends Error {}

/** Only an already-approved bot gets in, and what it declares this time is
    ignored: a taken-over image cannot re-ask a question already answered. */
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
      // Told the same thing as a pending bot: confirming somebody looked and
      // said no invites an argument with the message.
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
          // Wording kept as it was: this sentence reaches a person, and moving
          // the code and the copy at once leaves nothing to match a bug report.
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

    // Step 2: a signed assertion and a certificate. `note` rides here because
    // the challenge binds only what must not change between the two steps.
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

          // `grytUserId`, not `sub`: every table keys on this, so a CA trusted
          // for its own users cannot name somebody else's.
          grytUserId = cert.grytUserId;
          suggestedNickname = cert.preferredUsername;
          identityTier = cert.tier;

          // Only an account may claim a prior identity, and only a local one:
          // otherwise holding two keys is a way to shed a ban.
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

          // Which half failed, so a client whose certificate and key have
          // drifted can renew rather than sign in again, which cannot help.
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

        // Says exactly what is wrong, since the accepted tiers are already in
        // `server:info`. Bots come from the registry, not GRYT_IDENTITY_TIERS.
        let botRegistration: Awaited<ReturnType<typeof getBotById>> = null;
        if (identityTier === "bot") {
          const outcome = await admitBot(
            grytUserId,
            challenge.bot,
            // Used only the first time anybody sees it; after approval the
            // registration's name is the one that sticks.
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

        // Whatever was approved, not what the bot sent this time: it is the
        // label people trust a message by.
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

        // Ahead of invite consumption, so a banned user does not burn a code.
        // The refusal is deliberately uninformative; the audit log has the why.
        const identity = await checkIdentityAllowed(grytUserId);
        if (!identity.ok) {
          consola.info(`Join refused for ${grytUserId}: ${identity.code}`);
          socket.emit("server:error", {
            error: "join_refused",
            message: "Sorry, you can't join this server.",
          });
          return;
        }

        // A ban follows the identity being claimed, not only the one presented,
        // or signing up and linking back afterwards evades every ban.
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

        // Before anything reads it, so the join continues as the member they
        // already were, with their roles and what they owned.
        if (priorSub) {
          try {
            const carry = await carryIdentityForward(priorSub, grytUserId);
            if (carry.status === "carried") {
              consola.info(`Linked ${priorSub} to ${grytUserId} on join`);
              // `cfg` was read before the carry-over, which can change who owns
              // the server. Stale, it sends `isOwner: false` to the owner.
              cfg = await getServerConfig().catch(() => cfg);
            } else if (carry.status === "account_already_member") {
              // Both identities are already members, so nothing moves. This
              // line is what answers "where did my roles go" afterwards.
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

        // A bot's admission is its registration, so requiring an invite as well
        // would lock an approved bot out of a server on the default policy.
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
            // Before consuming, so a refusal does not spend a use. Keyed on the
            // code, so the limit holds across every machine with the link.
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
            // Ahead of the policy check: the first person through arrives
            // without an invite, and claiming later leaves nobody in charge.
            const claimed = await claimServerOwner(grytUserId);
            claimedOwnerGrytUserId = claimed.owner;
            const policy = normalizeJoinPolicy(cfg?.join_policy);
            const isClaimingOwner = claimedOwnerGrytUserId === grytUserId;

            if (!isClaimingOwner && policy === "request") {
              // Per address, not per identity: the row is keyed on identity and
              // a fresh local one costs nothing to make.
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
                // Take the row with them, or an approval readmits them forever,
                // including after they are removed.
                await clearJoinRequest(grytUserId);
                consola.info(`Approved join request used by ${grytUserId}`);
              } else {
                // A denial hears what a pending one hears: saying otherwise
                // confirms a moderator looked, which is the leak above.
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

        /* `isActiveMember` was read before all this, so a greeting plugin does
           not fire on every wifi drop. `emit` cannot throw or fail a join. */
        if (!isActiveMember) {
          pluginEvents().emit("member:joined", {
            userId: user.server_user_id,
            nickname: user.nickname ?? null,
            inviteCode: usedInviteCode ?? null,
            at: new Date().toISOString(),
          });
        }
        const isOwner = ((claimedOwnerGrytUserId ?? cfg?.owner_gryt_user_id) || null) === grytUserId;
        const setupRequired = isOwner && !cfg?.is_configured;
        const tokenVersion = cfg?.token_version ?? 0;

        // Skipped for a bot: its permissions live on the registration, and a
        // roles row would be a second place a role edit could widen.
        try {
          if (botRegistration) throw new BotHoldsNoRole();
          const existingRoles = await listMemberRoles(user.server_user_id);
          // First-time joiners land on their tier's default; existing members
          // keep what they were given, so a default change re-sorts nobody.
          const joinRole = defaultRoleForTier(identityTierOf(grytUserId), cfg);
          if (existingRoles.length === 0) {
            await setServerRole(user.server_user_id, isOwner ? "owner" : joinRole);
            // First join only, never a reconnect on the stored code. Added
            // rather than assigned, so an invite can only raise somebody.
            if (!isOwner && usedInviteCode) {
              await applyInviteRole(usedInviteCode, user.server_user_id);
            }
          } else if (isOwner && !existingRoles.includes("owner")) {
            // Added rather than assigned: the owner may hold other roles, and
            // replacing the set would drop them on every reconnect.
            await addMemberRole(user.server_user_id, "owner");
          }

          // Joining and sending are the two moments the answer can change, so
          // there is no timer here to fail quietly.
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
          // From the row this join resolved: a session legitimately starts
          // here, so the counter as it reads now is what the token gets.
          userTokenVersion: user.token_version ?? 0,
        };

        const accessToken = generateAccessToken(tokenPayload);
        // Reads uploads and nothing else. Deliberately the weaker token: it
        // rides in an `<img src>` query string, where a header cannot follow.
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
          // Sent on the way in, so a client does not have to wait for the first
          // member list to know whether they have a look here.
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

        // Outside the isActiveMember branch: somebody stuck on a build that
        // cannot update never joins for the first time again.
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
