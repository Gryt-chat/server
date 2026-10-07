import consola from "consola";

import { listPushDevices, removePushCapability, type PushDevice } from "../db";
import type { Clients } from "../types";
import { sealPreview, type PushPreview } from "./pushPreview";

/**
 * Waking phones through the push relay (GRYT-1656). The relay gets a capability and
 * a kind, nothing else: it writes the notification text itself.
 */

export type PushKind = "mention" | "dm" | "message";

/** Which of an account's phones want this push, by their own settings. Muted is checked on top. */
export type PushAccept = (device: PushDevice) => boolean;

export interface PushOptions {
  accept?: PushAccept;
  /** Asked once, and only when a phone with a preview key is about to be pushed (GRYT-1688). */
  preview?: () => Promise<PushPreview | null>;
}

export const DEFAULT_PUSH_RELAY = "https://push.gryt.chat";

/** Same shape the relay hands out. Anything else is refused before it is stored. */
export const CAPABILITY_SHAPE = /^p_[A-Za-z0-9_-]{43}$/;

/** One buzz per phone per conversation in this window. A busy DM is one notification, not twenty. */
const QUIET_MS = 15_000;
const TIMEOUT_MS = 5_000;

/** Unset means the public relay. "off" or empty turns pushes off for this server. */
export function readPushRelay(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.GRYT_PUSH_RELAY_URL;
  if (raw === undefined) return DEFAULT_PUSH_RELAY;
  const value = raw.trim();
  if (value === "" || value.toLowerCase() === "off") return null;
  try {
    const url = new URL(value);
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (url.protocol !== "https:" && !(local && url.protocol === "http:")) throw new Error("not https");
    return url.origin + url.pathname.replace(/\/+$/, "");
  } catch {
    consola.warn(`GRYT_PUSH_RELAY_URL "${value}" is not an https URL, so pushes are off`);
    return null;
  }
}

/** Somebody at a screen: a socket that is neither idle on the desktop nor a phone in a pocket. */
export function isPresent(clientsInfo: Clients, serverUserId: string): boolean {
  return Object.values(clientsInfo).some(
    (c) => c?.serverUserId === serverUserId && !c.isAFK && !c.appInBackground,
  );
}

export interface PusherDeps {
  relay: string | null;
  listDevices: (serverUserId: string) => PushDevice[];
  forget: (capability: string) => void;
  fetch: typeof fetch;
  now: () => number;
}

export function createPusher(deps: PusherDeps) {
  const lastSent = new Map<string, number>();
  const inFlight = new Set<Promise<void>>();

  async function send(device: PushDevice, kind: PushKind, preview: (() => Promise<PushPreview | null>) | null): Promise<void> {
    try {
      const shown = device.previewKey && preview ? await preview() : null;
      // Sealed to this phone's key, so the relay forwards it unread. Without one the relay's own text shows.
      const sealed = shown && device.previewKey ? sealPreview(device.previewKey, device.capability, shown) : undefined;
      const res = await deps.fetch(`${deps.relay}/v1/push`, {
        method: "POST",
        headers: { authorization: `Bearer ${device.capability}`, "content-type": "application/json" },
        body: JSON.stringify(sealed ? { kind, preview: sealed } : { kind }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      // 404: the relay forgot it. 410: Apple or Google said the phone is gone.
      if (res.status === 404 || res.status === 410) deps.forget(device.capability);
      else if (!res.ok && res.status !== 429) consola.debug(`push relay answered ${res.status}`);
    } catch (err) {
      consola.debug("push relay unreachable", (err as Error).message);
    }
  }

  /** Fire and forget: called after delivery, and never awaited by a send. */
  function notify(
    clientsInfo: Clients,
    serverUserIds: Iterable<string>,
    kind: PushKind,
    conversationId: string,
    options: PushOptions = {},
  ): void {
    if (!deps.relay) return;
    const now = deps.now();
    const accept = options.accept ?? (() => true);
    let preview: Promise<PushPreview | null> | null = null;
    const previewOnce = () => (preview ??= (options.preview?.() ?? Promise.resolve(null)).catch((err) => {
      consola.debug("push preview failed", (err as Error).message);
      return null;
    }));
    for (const serverUserId of new Set(serverUserIds)) {
      if (isPresent(clientsInfo, serverUserId)) continue;
      let devices: PushDevice[];
      try {
        devices = deps.listDevices(serverUserId);
      } catch (err) {
        consola.warn("listing push devices failed", err);
        continue;
      }
      for (const device of devices) {
        if (device.muted.has(conversationId) || !accept(device)) continue;
        const key = `${device.capability}:${conversationId}`;
        if (now - (lastSent.get(key) ?? 0) < QUIET_MS) continue;
        lastSent.set(key, now);
        const sending = send(device, kind, options.preview ? previewOnce : null).finally(() => inFlight.delete(sending));
        inFlight.add(sending);
      }
    }
    if (lastSent.size > 5_000) {
      for (const [key, at] of lastSent) if (now - at >= QUIET_MS) lastSent.delete(key);
    }
  }

  /** Tests only: resolves once every push sent so far has had its answer. */
  async function settled(): Promise<void> {
    while (inFlight.size > 0) await Promise.all([...inFlight]);
  }

  return { notify, settled };
}

let shared: ReturnType<typeof createPusher> | null = null;
let relay: string | null | undefined;

/** Read once, so a bad value warns once rather than on every message. */
function configuredRelay(): string | null {
  if (relay === undefined) relay = readPushRelay();
  return relay;
}

export function pushNotify(
  clientsInfo: Clients,
  serverUserIds: Iterable<string>,
  kind: PushKind,
  conversationId: string,
  options?: PushOptions,
): void {
  shared ??= createPusher({
    relay: configuredRelay(),
    listDevices: listPushDevices,
    forget: removePushCapability,
    fetch,
    now: Date.now,
  });
  shared.notify(clientsInfo, serverUserIds, kind, conversationId, options);
}

/** Tests only: every push so far has reached the relay and been answered. */
export function pushesSettled(): Promise<void> {
  return shared?.settled() ?? Promise.resolve();
}

/** Tests only: forget the throttle and read the relay setting again. */
export function resetPushState(): void {
  shared = null;
  relay = undefined;
}

export function pushEnabled(): boolean {
  return configuredRelay() !== null;
}
