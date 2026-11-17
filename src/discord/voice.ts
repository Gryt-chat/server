import consola from "consola";
import { ChannelType, Events, type Client, type Guild, type VoiceBasedChannel } from "discord.js";
import { EndBehaviorType, joinVoiceChannel, type AudioReceiveStream, type VoiceConnection } from "@discordjs/voice";

import { getDiscordBridge, grytChannelFor, isExcludedFromBridge } from "../db";
import { importedId } from "../import/discord/ids";
import { pluginRefs } from "../plugins/refs";
import { syncAllClients } from "../socket/utils/clients";
import { sfuRoomId } from "../socket/utils/voiceRooms";
import { removeDiscordVoiceParticipant, setDiscordVoiceParticipant } from "./voiceParticipants";

/** Discord sends 20 ms Opus frames; 960 samples at 48 kHz. */
const FRAME = 960;
const PACKET_VERSION = 1;
const FLAG_SPEAKING = 1;

/** One own-transport datagram (@gryt/voice transport/packet.ts): version, flags, seq u16, timestamp u32, then the Opus packet. */
export function voicePacket(seq: number, timestamp: number, opus: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + opus.length);
  const view = new DataView(out.buffer);
  view.setUint8(0, PACKET_VERSION);
  view.setUint8(1, FLAG_SPEAKING);
  view.setUint16(2, seq & 0xffff);
  view.setUint32(4, timestamp >>> 0);
  out.set(opus, 8);
  return out;
}

/** The timestamp advances by real time across a pause, so the listener's jitter buffer doesn't squeeze the gap out. */
export function nextTimestamp(previous: number, lastAt: number, now: number): number {
  const frames = Math.max(1, Math.round((now - lastAt) / 20));
  return (previous + frames * FRAME) >>> 0;
}

interface Speaker {
  serverUserId: string;
  stream: AudioReceiveStream | null;
  seq: number;
  timestamp: number;
  lastAt: number;
}

interface Bridged {
  discordChannelId: string;
  grytChannelId: string;
  conn: VoiceConnection;
  people: Map<string, Speaker>;
}

let current: Bridged | null = null;

function grytVoiceCount(grytChannelId: string): number {
  const refs = pluginRefs();
  if (!refs) return 0;
  return Object.values(refs.clientsInfo).filter((c) => c.hasJoinedChannel && c.voiceChannelId === grytChannelId).length;
}

function humans(channel: VoiceBasedChannel) {
  return [...channel.members.values()].filter((m) => !m.user.bot && !isExcludedFromBridge("discord", m.id));
}

/** The matched voice channel with people on both sides, the busiest on Gryt first. A bot is in one voice channel per Discord server. */
function pick(guild: Guild): { channel: VoiceBasedChannel; grytChannelId: string } | null {
  let best: { channel: VoiceBasedChannel; grytChannelId: string; count: number } | null = null;
  for (const ch of guild.channels.cache.values()) {
    if (ch.type !== ChannelType.GuildVoice && ch.type !== ChannelType.GuildStageVoice) continue;
    const grytChannelId = grytChannelFor(ch.id, importedId("channel", ch.id));
    if (!grytChannelId || humans(ch).length === 0) continue;
    const count = grytVoiceCount(grytChannelId);
    if (count > 0 && (!best || count > best.count)) best = { channel: ch, grytChannelId, count };
  }
  return best;
}

function broadcast(): void {
  const refs = pluginRefs();
  if (refs) syncAllClients(refs.io, refs.clientsInfo);
}

function addPerson(b: Bridged, guild: Guild, discordUserId: string): void {
  const refs = pluginRefs();
  if (b.people.has(discordUserId) || !refs?.sfuClient) return;
  const member = guild.members.cache.get(discordUserId);
  if (!member || member.user.bot || isExcludedFromBridge("discord", discordUserId)) return;
  const serverUserId = `discord:${discordUserId}`;
  refs.sfuClient.virtualVoiceJoin(sfuRoomId(refs.serverId, b.grytChannelId), serverUserId);
  setDiscordVoiceParticipant({ serverUserId, name: member.displayName, avatar: member.displayAvatarURL({ extension: "png", size: 128 }), channelId: b.grytChannelId });
  b.people.set(discordUserId, { serverUserId, stream: null, seq: 0, timestamp: 0, lastAt: 0 });
  broadcast();
}

function listen(b: Bridged, discordUserId: string): void {
  const person = b.people.get(discordUserId);
  const sfu = pluginRefs()?.sfuClient;
  if (!person || person.stream || !sfu) return;
  const stream = b.conn.receiver.subscribe(discordUserId, { end: { behavior: EndBehaviorType.Manual } });
  person.stream = stream;
  stream.on("data", (opus: Buffer) => {
    const now = Date.now();
    person.seq = (person.seq + 1) & 0xffff;
    person.timestamp = person.lastAt ? nextTimestamp(person.timestamp, person.lastAt, now) : 0;
    person.lastAt = now;
    sfu.sendVirtualAudio(person.serverUserId, voicePacket(person.seq, person.timestamp, opus));
  });
  stream.on("error", (e) => consola.warn("[DiscordVoice] receive failed", e.message));
}

function dropPerson(b: Bridged, discordUserId: string): void {
  const person = b.people.get(discordUserId);
  if (!person) return;
  person.stream?.destroy();
  pluginRefs()?.sfuClient?.virtualVoiceLeave(person.serverUserId);
  removeDiscordVoiceParticipant(person.serverUserId);
  b.people.delete(discordUserId);
  broadcast();
}

function leave(): void {
  const b = current;
  current = null;
  if (!b) return;
  for (const id of [...b.people.keys()]) dropPerson(b, id);
  b.conn.destroy();
}

function join(guild: Guild, channel: VoiceBasedChannel, grytChannelId: string): void {
  const conn = joinVoiceChannel({ channelId: channel.id, guildId: guild.id, adapterCreator: guild.voiceAdapterCreator, selfDeaf: false, selfMute: true });
  const b: Bridged = { discordChannelId: channel.id, grytChannelId, conn, people: new Map() };
  current = b;
  conn.receiver.speaking.on("start", (userId) => {
    if (current !== b) return;
    addPerson(b, guild, userId);
    listen(b, userId);
  });
  for (const m of humans(channel)) addPerson(b, guild, m.id);
}

/** Joins, moves or leaves so the bot sits in the one bridged voice channel where both sides have people. */
export function reconcileVoice(c: Client): void {
  const b = getDiscordBridge();
  const guild = b?.guild_id ? c.guilds.cache.get(b.guild_id) : undefined;
  const wanted = b?.status === "linked" && b.direction !== "to_discord" && guild ? pick(guild) : null;
  if (!wanted || !guild) {
    leave();
    return;
  }
  if (current?.discordChannelId === wanted.channel.id) {
    const here = new Set(humans(wanted.channel).map((m) => m.id));
    for (const id of [...current.people.keys()]) if (!here.has(id)) dropPerson(current, id);
    for (const id of here) addPerson(current, guild, id);
    return;
  }
  leave();
  join(guild, wanted.channel, wanted.grytChannelId);
}

export function attachVoiceBridge(c: Client): void {
  const tick = () => {
    try {
      reconcileVoice(c);
    } catch (e) {
      consola.warn("[DiscordVoice] reconcile failed", e);
    }
  };
  c.on(Events.VoiceStateUpdate, tick);
  // Gryt members joining or leaving voice don't reach the bot, so it looks every few seconds.
  const timer = setInterval(tick, 3000);
  timer.unref();
  c.once("shardDisconnect", () => clearInterval(timer));
  c.on(Events.ClientReady, tick);
}

export function stopVoiceBridge(): void {
  leave();
}
