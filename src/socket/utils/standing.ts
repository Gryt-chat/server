import type { Permission } from "../../constants/permissions";
import { getEffectiveStanding, hasPermission } from "../../services/permissions";
import type { Clients } from "../../types";

/** For events that carry no access token. Reads the database every time: a
    stale cache saying yes is a permission that outlives its removal. */
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

/** `socketMay` gives the same false for "not yet" as for a refusal. Callers that
    report the refusal need this, or a client told forbidden stops asking. */
export function socketIsIdentified(
  clientsInfo: Clients,
  clientId: string,
): boolean {
  const serverUserId = clientsInfo[clientId]?.serverUserId;
  return Boolean(serverUserId) && !serverUserId!.startsWith("temp_");
}

/** Delivery only; nothing authorises against this. Worst case a stale entry
    sends one message to somebody who just lost `read_messages`. */
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

/** A socket with no cached standing has not proved who it is. The refresh runs
    as part of joining, so the gap is milliseconds. */
export function clientMayReceive(
  clientsInfo: Clients,
  clientId: string,
  permission: Permission,
): boolean {
  return clientsInfo[clientId]?.permissions?.has(permission) ?? false;
}
