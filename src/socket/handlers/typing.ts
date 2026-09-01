import type { HandlerContext, EventHandlerMap } from "./types";
import { getUserByServerId } from "../../db";
import { checkRateLimit, RateLimitRule } from "../../utils/rateLimiter";
import { mayViewChannel } from "../../services/channelPermissions";
import { resolveConversationAccess } from "../utils/conversationAccess";

const RL_TYPING: RateLimitRule = { limit: 30, windowMs: 10_000, scorePerAction: 0.2, maxScore: 6, scoreDecayMs: 1500 };
const TYPING_TIMEOUT_MS = 8_000;

const typingTimers = new Map<string, ReturnType<typeof setTimeout>>();

function timerKey(serverUserId: string, conversationId: string): string {
	return `${serverUserId}:${conversationId}`;
}

export function registerTypingHandlers(ctx: HandlerContext): EventHandlerMap {
	const { io, clientId, clientsInfo, getClientIp } = ctx;

	/**
	 * The clients that should hear that somebody is typing here, or null if the
	 * typist has no business in this conversation at all.
	 *
	 * Both events used to go to every connected socket. That was harmless while
	 * every conversation was a channel every member could see, and it stopped
	 * being harmless twice: once when direct messages arrived, and again with
	 * `view_min_rank`. The payload carries the conversation id, so an
	 * unfiltered indicator names a private conversation — and names one of the
	 * two people in it — every few seconds while either of them types.
	 *
	 * Same shape as `recipientClientIds` in chat.ts, and for the same reason:
	 * who may hear about a conversation is one question, and answering it twice
	 * is two chances to answer it differently.
	 */
	async function typingAudience(conversationId: string, typistId: string): Promise<string[] | null> {
		const access = await resolveConversationAccess(conversationId, typistId);
		if (!access.allowed) return null;

		const others = Object.keys(clientsInfo).filter((cid) => cid !== clientId);

		if (access.kind === "dm") {
			const members = new Set(access.memberIds);
			return others.filter((cid) => members.has(clientsInfo[cid]?.serverUserId ?? ""));
		}

		const allowed = await Promise.all(
			others.map((cid) => mayViewChannel(conversationId, clientsInfo[cid]?.serverUserId)),
		);
		return others.filter((_, i) => allowed[i]);
	}

	async function broadcastStopTyping(serverUserId: string, conversationId: string) {
		const key = timerKey(serverUserId, conversationId);
		const existing = typingTimers.get(key);
		if (existing) clearTimeout(existing);
		typingTimers.delete(key);

		// The timer still clears above even when the audience is empty or the
		// access has since been withdrawn. A stuck "typing…" that never stops
		// is what you get otherwise, on the client that did see the start.
		const audience = await typingAudience(conversationId, serverUserId);
		for (const cid of audience ?? []) {
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

			// Resolved before the timer is set, so a guessed id for a hidden
			// channel or somebody else's DM never reaches anyone — and never
			// leaves a timer behind that would fire a stop for a conversation
			// the typist was refused.
			const audience = await typingAudience(payload.conversationId, userId);
			if (!audience) return;

			const key = timerKey(userId, payload.conversationId);
			const existing = typingTimers.get(key);
			if (existing) clearTimeout(existing);

			typingTimers.set(key, setTimeout(() => {
				broadcastStopTyping(userId, payload.conversationId).catch(() => { /* the sockets went away */ });
			}, TYPING_TIMEOUT_MS));

			for (const cid of audience) {
				io.sockets.sockets.get(cid)?.emit("chat:typing", {
					serverUserId: userId,
					nickname: user.nickname,
					avatarFileId: user.avatar_file_id ?? null,
					// The indicator draws a face, so it needs the same three
					// things every other face in the app is drawn from.
					avatarWorn: user.avatar_worn ?? null,
					conversationId: payload.conversationId,
				});
			}
		},

		"chat:stop_typing": async (payload: { conversationId: string }) => {
			const userId = clientsInfo[clientId]?.serverUserId;
			if (!userId || !payload?.conversationId) return;

			await broadcastStopTyping(userId, payload.conversationId);
		},
	};
}
