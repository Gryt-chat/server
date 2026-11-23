import type { Clients } from "../types";

/** People in a voice channel right now, once each however many tabs they have. */
export function countVoiceUsers(clients: Clients): number {
  const people = new Set<string>();
  for (const [id, c] of Object.entries(clients)) if (c.hasJoinedChannel) people.add(c.serverUserId ?? id);
  return people.size;
}

// Set by the socket layer, so the management API can read it without importing all of it.
let read: () => number = () => 0;
export const setVoiceUsersReader = (fn: () => number): void => {
  read = fn;
};
export const voiceUsers = (): number => read();
