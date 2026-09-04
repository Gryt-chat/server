import type { Permission } from "../../constants/permissions";
import { getEffectiveStanding, hasPermission } from "../../services/permissions";
import type { Clients } from "../../types";

/**
 * Whether the person behind a socket may do something, for the events that
 * carry no access token. An unidentified socket is refused.
 *
 * **Reads the database every time.** The cached copy below is not used here: a
 * stale cache saying yes is a permission that outlives its removal.
 */
export async function socketMay(
  clientsInfo: Clients,
  clientId: string,
  permission: Permission,
): Promise<boolean> {
  const client = clientsInfo[clientId];
  const serverUserId = client?.serverUserId;
  if (!serverUserId || serverUserId.startsWith("temp_")) return false;
  return hasPermission(serverUserId, permission, client?.grytUserId);
}

/**
 * Whether this socket has said who it is yet. `socketMay` answers false for a
 * `temp_` socket, correctly, but that is the same false it gives a refusal —
 * one is a decision and the other is a moment.
 *
 * Callers that gate an action can treat both as no. Callers that *report* the
 * refusal need this: "forbidden" when the truth is "not yet" makes a client
 * stop asking (GRYT-647).
 */
export function socketIsIdentified(
  clientsInfo: Clients,
  clientId: string,
): boolean {
  const serverUserId = clientsInfo[clientId]?.serverUserId;
  return Boolean(serverUserId) && !serverUserId!.startsWith("temp_");
}

/**
 * The same answer, cached on the socket, for deciding who a broadcast goes to.
 * Refreshed whenever the server rebroadcasts its details, which already happens
 * on every role change, definition edit and settings update.
 *
 * **Delivery only. Nothing authorises against this.** The worst a stale entry
 * does is send one message to somebody who just lost `read_messages`. That is
 * why this and `socketMay` are two functions rather than one with a flag.
 */
export async function refreshClientPermissions(
  clientsInfo: Clients,
  clientId: string,
): Promise<void> {
  const client = clientsInfo[clientId];
  if (!client) return;
  if (!client.serverUserId || client.serverUserId.startsWith("temp_")) {
    client.permissions = undefined;
    return;
  }
  const standing = await getEffectiveStanding(client.serverUserId, client.grytUserId);
  client.permissions = standing.permissions;
}

export async function refreshAllClientPermissions(clientsInfo: Clients): Promise<void> {
  await Promise.all(
    Object.keys(clientsInfo).map((id) => refreshClientPermissions(clientsInfo, id)),
  );
}

/**
 * Whether a broadcast should reach this socket.
 *
 * A socket with no cached standing yet — one that has connected but not
 * finished joining — is not sent anything. It has not proved who it is, and the
 * refresh runs as part of joining, so the gap is measured in milliseconds.
 */
export function clientMayReceive(
  clientsInfo: Clients,
  clientId: string,
  permission: Permission,
): boolean {
  return clientsInfo[clientId]?.permissions?.has(permission) ?? false;
}
