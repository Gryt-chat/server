import type { HandlerContext, EventHandlerMap } from "./types";
import { getUserByServerId } from "../../db";
import { effectiveModerationState } from "../../db/sqlite/users";
import { checkRateLimit, RateLimitRule } from "../../utils/rateLimiter";
import { mayViewChannel } from "../../services/channelPermissions";
import { resolveConversationAccess } from "../utils/conversationAccess";

const RL_TYPING: RateLimitRule = { limit: 30, windowMs: 10_000, scorePerAction: 0.2, maxScore: 6, scoreDecayMs: 1500 };
const TYPING_TIMEOUT_MS = 8_000;

const typingTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** A thread is a place somebody can be typing, and left out of the key a reply
    clears the channel's timer, so its stop never fires. */
function timerKey(serverUserId: string, conversationId: string, threadId?: string | null): string {
	return `${serverUserId}:${conversationId}:${threadId ?? ""}`;
}

export function registerTypingHandlers(ctx: HandlerContext): EventHandlerMap {
	const { io, clientId, clientsInfo, getClientIp } = ctx;

	/** Null when the typist has no business in the conversation. The payload
	    carries its id, so an unfiltered indicator names a private one. */
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

	async function broadcastStopTyping(
		serverUserId: string,
		conversationId: string,
		threadId?: string | null,
	) {
		const key = timerKey(serverUserId, conversationId, threadId);
		const existing = typingTimers.get(key);
		if (existing) clearTimeout(existing);
		typingTimers.delete(key);

		// The timer clears above even with an empty audience, or the client that
		// saw the start is left on a "typing…" that never stops.
		const audience = await typingAudience(conversationId, serverUserId);
		for (const cid of audience ?? []) {
			io.sockets.sockets.get(cid)?.emit("chat:stop_typing", {
				serverUserId,
				conversationId,
				threadId: threadId ?? null,
			});
		}
	}

	return {
		/* A thread has no gate of its own, so the audience is the channel's and
		   the thread only says which composer the typing is in. */
		"chat:typing": async (payload: { conversationId: string; threadId?: string | null }) => {
			const userId = clientsInfo[clientId]?.serverUserId;
			if (!userId || !payload?.conversationId) return;

			const ip = getClientIp();
			const rl = checkRateLimit("chat:typing", userId, ip, RL_TYPING);
			if (!rl.allowed) return;

			const user = await getUserByServerId(userId);
			if (!user) return;

			// A muted member is not going to say anything. Read off the row
			// already fetched rather than through `textMuteFor`.
			if (effectiveModerationState(user).isServerMuted) return;

			// Before the timer is set, so a guessed id neither reaches anyone nor
			// leaves a timer that fires a stop for a refused conversation.
			const audience = await typingAudience(payload.conversationId, userId);
			if (!audience) return;

			const threadId = payload.threadId ?? null;
			const key = timerKey(userId, payload.conversationId, threadId);
			const existing = typingTimers.get(key);
			if (existing) clearTimeout(existing);

			typingTimers.set(key, setTimeout(() => {
				broadcastStopTyping(userId, payload.conversationId, threadId).catch(() => { /* the sockets went away */ });
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
					threadId,
				});
			}
		},

		"chat:stop_typing": async (payload: { conversationId: string; threadId?: string | null }) => {
			const userId = clientsInfo[clientId]?.serverUserId;
			if (!userId || !payload?.conversationId) return;

			await broadcastStopTyping(userId, payload.conversationId, payload.threadId ?? null);
		},
	};
}
