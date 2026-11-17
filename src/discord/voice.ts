import consola from "consola";
import { ChannelType, Events, type Client, type Guild, type VoiceBasedChannel } from "discord.js";
import { Readable } from "node:stream";

import {
  EndBehaviorType,
  NoSubscriberBehavior,
  StreamType,
  createAudioPlayer,
  createAudioResource,
  joinVoiceChannel,
  type AudioPlayer,
  type AudioReceiveStream,
  type VoiceConnection,
} from "@discordjs/voice";

import { getDiscordBridge, grytChannelFor, isExcludedFromBridge } from "../db";
import { importedId } from "../import/discord/ids";
import { pluginRefs } from "../plugins/refs";
import { syncAllClients } from "../socket/utils/clients";
import { sfuRoomId } from "../socket/utils/voiceRooms";
import { Regroup } from "./opusFrames";
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

/** The bot's own voice member in the Gryt room, which hears it and speaks into Discord. */
export const BRIDGE_LISTENER = "discord-bridge";
/** How long the current speaker keeps the floor after their last packet. */
const FLOOR_MS = 400;
/** About 200 ms of audio waiting; past that, packets are dropped so Discord doesn't fall behind. */
const MAX_QUEUED = 10;

/** Who is heard in Discord: whoever talks keeps it until they've been quiet for FLOOR_MS. */
export class Floor {
  speaker: string | null = null;
  private lastAt = 0;

  /** True when this packet is the one to play; `changed` when it starts a new speaker. */
  take(speaker: string, now: number): { play: boolean; changed: boolean } {
    if (this.speaker === speaker) {
      this.lastAt = now;
      return { play: true, changed: false };
    }
    if (this.speaker && now - this.lastAt < FLOOR_MS) return { play: false, changed: false };
    this.speaker = speaker;
    this.lastAt = now;
    return { play: true, changed: true };
  }
}

interface Outbound {
  player: AudioPlayer;
  stream: Readable;
  regroup: Regroup;
  floor: Floor;
}

interface Bridged {
  discordChannelId: string;
  grytChannelId: string;
  conn: VoiceConnection;
  people: Map<string, Speaker>;
  out: Outbound | null;
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
  if (b.out) {
    pluginRefs()?.sfuClient?.virtualVoiceLeave(BRIDGE_LISTENER);
    b.out.player.stop(true);
    b.out.stream.destroy();
  }
  b.conn.destroy();
}

/** Gryt into Discord: one voice at a time, since a bot is one speaker there. Whoever talks keeps it until they stop. */
export function hearGryt(listener: string, speaker: string, datagram: Buffer): void {
  const out = current?.out;
  if (listener !== BRIDGE_LISTENER || !out || datagram.length <= 8 || datagram[0] !== 1) return;
  if (speaker.startsWith("discord:") || isExcludedFromBridge("gryt", speaker)) return;
  const turn = out.floor.take(speaker, Date.now());
  if (!turn.play) return;
  if (turn.changed) out.regroup.reset();
  for (const packet of out.regroup.push(datagram.subarray(8))) {
    if (out.stream.readableLength < MAX_QUEUED) out.stream.push(Buffer.from(packet));
  }
}

function speakIntoDiscord(b: Bridged): void {
  const refs = pluginRefs();
  if (!refs?.sfuClient) return;
  const stream = new Readable({ objectMode: true, read() {} });
  const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play, maxMissedFrames: Number.POSITIVE_INFINITY } });
  player.play(createAudioResource(stream, { inputType: StreamType.Opus }));
  player.on("error", (e) => consola.warn("[DiscordVoice] playing into Discord failed", e.message));
  b.conn.subscribe(player);
  b.out = { player, stream, regroup: new Regroup(), floor: new Floor() };
  refs.sfuClient.setVirtualAudioHandler(hearGryt);
  refs.sfuClient.virtualVoiceJoin(sfuRoomId(refs.serverId, b.grytChannelId), BRIDGE_LISTENER, true);
}

function join(guild: Guild, channel: VoiceBasedChannel, grytChannelId: string): void {
  const direction = getDiscordBridge()?.direction;
  const conn = joinVoiceChannel({ channelId: channel.id, guildId: guild.id, adapterCreator: guild.voiceAdapterCreator, selfDeaf: false, selfMute: direction === "to_gryt" });
  const b: Bridged = { discordChannelId: channel.id, grytChannelId, conn, people: new Map(), out: null };
  current = b;
  if (direction !== "to_gryt") speakIntoDiscord(b);
  if (direction === "to_discord") return;
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
  const wanted = b?.status === "linked" && guild ? pick(guild) : null;
  if (!wanted || !guild) {
    leave();
    return;
  }
  if (current?.discordChannelId === wanted.channel.id) {
    if (b?.direction === "to_discord") return;
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
