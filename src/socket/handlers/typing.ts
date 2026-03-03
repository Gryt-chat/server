import type { HandlerContext, EventHandlerMap } from "./types";
import { getUserByServerId } from "../../db";
import { checkRateLimit, RateLimitRule } from "../../utils/rateLimiter";

const RL_TYPING: RateLimitRule = { limit: 30, windowMs: 10_000, scorePerAction: 0.2, maxScore: 6, scoreDecayMs: 1500 };
const TYPING_TIMEOUT_MS = 8_000;

const typingTimers = new Map<string, ReturnType<typeof setTimeout>>();

function timerKey(serverUserId: string, conversationId: string): string {
	return `${serverUserId}:${conversationId}`;
}

export function registerTypingHandlers(ctx: HandlerContext): EventHandlerMap {
	const { io, socket: _socket, clientId, clientsInfo, getClientIp } = ctx;

	function broadcastStopTyping(serverUserId: string, conversationId: string) {
		const key = timerKey(serverUserId, conversationId);
		const existing = typingTimers.get(key);
		if (existing) clearTimeout(existing);
		typingTimers.delete(key);

		for (const [cid] of Object.entries(clientsInfo)) {
			if (cid === clientId) continue;
			io.sockets.sockets.get(cid)?.emit("chat:stop_typing", { serverUserId, conversationId });
		}
	}

	return {
		"chat:typing": async (payload: { conversationId: string }) => {
			const userId = clientsInfo[clientId]?.serverUserId;
			if (!userId || !payload?.conversationId) return;

			const ip = getClientIp();
			const rl = checkRateLimit("chat:typing", userId, ip, RL_TYPING);
			if (!rl.allowed) return;

			const user = await getUserByServerId(userId);
			if (!user) return;

			const key = timerKey(userId, payload.conversationId);
			const existing = typingTimers.get(key);
			if (existing) clearTimeout(existing);

			typingTimers.set(key, setTimeout(() => {
				broadcastStopTyping(userId, payload.conversationId);
			}, TYPING_TIMEOUT_MS));

			for (const [cid] of Object.entries(clientsInfo)) {
				if (cid === clientId) continue;
				io.sockets.sockets.get(cid)?.emit("chat:typing", {
					serverUserId: userId,
					nickname: user.nickname,
					avatarFileId: user.avatar_file_id ?? null,
					conversationId: payload.conversationId,
				});
			}
		},

		"chat:stop_typing": (payload: { conversationId: string }) => {
			const userId = clientsInfo[clientId]?.serverUserId;
			if (!userId || !payload?.conversationId) return;

			broadcastStopTyping(userId, payload.conversationId);
		},
	};
}
