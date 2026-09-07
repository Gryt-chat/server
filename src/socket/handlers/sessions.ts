import consola from "consola";

import { createRefreshToken, getUserByServerId, revokeUserSessions } from "../../db";
import { disconnectOtherSessions } from "../../moderation/evict";
import { generateAccessToken, generateFileToken } from "../../utils/jwt";
import { requireAuth } from "../middleware/auth";
import type { EventHandlerMap, HandlerContext } from "./types";

/**
 * A member ending their own sessions on this server.
 *
 * The counter this moves is per member, so it reaches every device they are
 * signed in on here and touches nobody else. It does not reach the other Gryt
 * servers they have joined: those keep their own counters, sign their own
 * tokens, and have never heard of this one. That is the same property that lets
 * somebody run a server on a LAN with no internet, and it means this is "sign
 * out of everywhere on this server" rather than "sign out of Gryt".
 */
export function registerSessionHandlers(ctx: HandlerContext): EventHandlerMap {
  const { io, socket, clientId, serverId, clientsInfo, sfuClient } = ctx;

  return {
    /**
     * Sign out every other device, and stay signed in on this one.
     *
     * Order matters. The bump invalidates every token this member holds — this
     * socket's included — so a replacement is minted and handed over before the
     * other sockets are dropped. Doing it the other way round would sign the
     * person out of the device they are sitting at, which is the one thing they
     * did not ask for.
     */
    'session:revoke_others': async (payload: { accessToken?: string }) => {
      try {
        const auth = await requireAuth(socket, payload);
        if (!auth) return;

        const { grytUserId, serverUserId } = auth.tokenPayload;

        // Both halves together: the counter moves so the tokens already out
        // there stop matching, and the refresh tokens go so none of those
        // devices can mint a replacement.
        await revokeUserSessions(grytUserId);

        const user = await getUserByServerId(serverUserId);
        if (!user) {
          socket.emit("server:error", {
            error: "membership_required",
            message: "Could not find your membership on this server.",
          });
          return;
        }

        const renewed = {
          grytUserId,
          serverUserId,
          nickname: user.nickname,
          serverHost: socket.handshake.headers.host || "unknown",
          tokenVersion: auth.config.token_version ?? 0,
          userTokenVersion: user.token_version ?? 0,
        };

        const accessToken = generateAccessToken(renewed);
        const fileToken = generateFileToken(renewed);
        // This device's refresh token went with all the others, so it needs a
        // new one or its next refresh falls through to a full rejoin.
        const refreshTokenRecord = await createRefreshToken({ grytUserId, serverUserId });

        if (clientsInfo[clientId]) {
          clientsInfo[clientId].accessToken = accessToken;
        }

        socket.emit("token:refreshed", {
          accessToken,
          fileToken,
          refreshToken: refreshTokenRecord.token_id,
        });

        const dropped = await disconnectOtherSessions({
          io,
          clientsInfo,
          serverId,
          sfuClient,
          targetGrytUserId: grytUserId,
          keepSocketId: socket.id,
        });

        socket.emit("session:revoked_others", { sessions: dropped });
      } catch (err) {
        consola.error("session:revoke_others failed", err);
        socket.emit("server:error", {
          error: "revoke_failed",
          message: "Could not sign out your other devices.",
        });
      }
    },
  };
}
