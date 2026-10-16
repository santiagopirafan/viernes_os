export interface ChannelContext {
  channel: string;
  operatorId: string;
  ts: number;
}

export function authenticate(channel: string): ChannelContext | null {
  if (channel === "cli") {
    return { channel, operatorId: "santipyrafan", ts: Date.now() };
  }
  if (channel === "whatsapp") {
    return { channel, operatorId: "santipyrafan", ts: Date.now() };
  }
  return null;
}
