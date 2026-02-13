declare module "openclaw/plugin-sdk" {
  export const DEFAULT_ACCOUNT_ID: string;
  export function normalizeAccountId(id: string): string;
  export function getChatChannelMeta(id: string): any;
  export type ChannelPlugin<T> = any;
  export type MoltbotPluginApi = any;
  export function emptyPluginConfigSchema(): any;
  export type ChannelMessageActionAdapter = any;
}
