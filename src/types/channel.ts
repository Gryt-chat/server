export type Channel = {
  name: string;
  type: "voice" | "text";
  permissions?: {
    canStreamRole: string;
    canSpeakRole: string;
    canJoinRole: string;
  };
};
