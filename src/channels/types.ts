export type MessageHandler = (input: string, channelId: string) => Promise<string>;

export interface Channel {
  id: string;
  start(handler: MessageHandler): void;
}
