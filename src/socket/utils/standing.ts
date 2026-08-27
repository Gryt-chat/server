import type { Permission } from "../../constants/permissions";
import { getEffectiveStanding, hasPermission } from "../../services/permissions";
import type { Clients } from "../../types";

/**
 * Whether the person behind a socket may do something.
 *
 * For the events that carry no access token — history fetches, the voice state
 * stream, the member list — where the socket's identity is what `clientsInfo`
 * recorded when it joined. An unidentified socket is refused.
 *
 * Reads the database every time, deliberately. There is a cached copy of the
 * same answer below and it is not used here: a stale cache that says yes is a
 * permission that outlives its removal, and the cost of being right is one
 * lookup on a table with five rows.
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
 * Whether this socket has said who it is yet.
 *
 * A socket is given `temp_<id>` at connection and keeps it until
 * `session:restore` or a join finishes. `socketMay` answers false for one of
 * those, correctly — a placeholder holds no permissions — but false is the same
 * answer it gives somebody who has been refused, and the two are not the same
 * thing. One is a decision and the other is a moment.
 *
 * Callers that only gate an action can keep using `socketMay` and treat both as
 * no. Callers that *report* the refusal need this: telling a client it is
 * forbidden when the truth is "not yet" makes it stop asking (GRYT-647).
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
 *
 * Chat messages and member lists go out to every connected socket, and asking
 * the database per socket per message is the wrong shape. So the standing is
 * cached when somebody joins and refreshed whenever the server rebroadcasts its
 * details — which is already what happens on every role change, definition
 * edit and settings update.
 *
 * **Delivery only.** Nothing authorises against this. The worst a stale entry
 * can do is send one message to somebody who just lost `read_messages`, or
 * withhold one from somebody who just gained it, and the next refresh corrects
 * it. That is a very different failure from a stale entry deciding whether a
 * ban sticks, which is why the two are separate functions rather than one with
 * a flag.
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
