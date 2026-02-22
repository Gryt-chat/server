import { Channel } from "../../types/channel";

export function getChannels(): { [id: string]: Channel } {
  // get channels from database
  return {
    "1": {
      name: "Channel #1",
      type: "voice",
      permissions: {
        canJoinRole: "*",
        canSpeakRole: "*",
        canStreamRole: "*",
      },
    },
  };
}

export function getChannelPermissions(channelID: string) {
  const channels = getChannels();
  // get channel permissions from database
  return channels[channelID].permissions;
}
