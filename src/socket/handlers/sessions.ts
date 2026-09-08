import consola from "consola";

import { createRefreshToken, getUserByServerId, revokeUserSessions } from "../../db";
import { disconnectOtherSessions } from "../../moderation/evict";
import { generateAccessToken, generateFileToken } from "../../utils/jwt";
import { requireAuth } from "../middleware/auth";
import type { EventHandlerMap, HandlerContext } from "./types";

/**
 * Per member, so it reaches their devices and nobody else's. Not the other Gryt
 * servers they joined: this is sign out of this server, not out of Gryt.
 */
export function registerSessionHandlers(ctx: HandlerContext): EventHandlerMap {
  const { io, socket, clientId, serverId, clientsInfo, sfuClient } = ctx;

  return {
    /** The bump invalidates this socket's token too, so a replacement is minted
        and handed over before the other sockets are dropped. */
    'session:revoke_others': async (payload: { accessToken?: string }) => {
      try {
        const auth = await requireAuth(socket, payload);
        if (!auth) return;

        const { grytUserId, serverUserId } = auth.tokenPayload;

        // Both halves: the counter moves so existing tokens stop matching, and
        // the refresh tokens go so no device can mint a replacement.
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
