import { v5 as uuidv5 } from "uuid";

/** Fixed forever: changing it gives every imported row a new id, and a rerun duplicates the lot. */
const DISCORD_IMPORT_NAMESPACE = "3f0d9a57-2c1b-4e8f-9a61-7d2b5e4c1f08";

export type ImportedKind = "channel" | "message" | "thread" | "folder" | "file" | "avatar" | "sticker";

/** The same Discord thing gets the same Gryt id on every run, which is all idempotency needs. */
export function importedId(kind: ImportedKind, key: string): string {
  return uuidv5(`${kind}:${key}`, DISCORD_IMPORT_NAMESPACE);
}

export const DISCORD_SENDER_PREFIX = "discord:";

/** The masquerade: a sender id no member can hold, since theirs are `user_<uuid>`. */
export function discordSenderId(discordUserId: string): string {
  return `${DISCORD_SENDER_PREFIX}${discordUserId}`;
}

export function folderItemId(categoryId: string): string {
  return `sb_discord_${importedId("folder", categoryId)}`;
}
