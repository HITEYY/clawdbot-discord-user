declare module "clawdbot/plugin-sdk" {
  export interface ClawdbotPluginApi {
    runtime: any;
    config: any;
    logger: any;
    registerChannel(params: { plugin: ChannelPlugin<any> }): void;
    registerGatewayMethod(name: string, handler: any): void;
    registerCli(handler: any, opts?: any): void;
    registerCommand(cmd: any): void;
    registerService(service: any): void;
    registerProvider(provider: any): void;
  }

  export interface ChannelPlugin<T = any> {
    id: string;
    meta: {
      id: string;
      label: string;
      selectionLabel?: string;
      docsPath?: string;
      docsLabel?: string;
      blurb?: string;
      aliases?: string[];
      showConfigured?: boolean;
      quickstartAllowFrom?: boolean;
      forceAccountBinding?: boolean;
      preferSessionLookupForAnnounceTarget?: boolean;
    };
    onboarding?: any;
    agentTools?: () => any[];
    pairing?: any;
    capabilities: {
      chatTypes: Array<"direct" | "channel" | "thread" | "group">;
      polls?: boolean;
      reactions?: boolean;
      threads?: boolean;
      media?: boolean;
      nativeCommands?: boolean;
    };
    streaming?: {
      blockStreamingCoalesceDefaults?: { minChars: number; idleMs: number };
    };
    reload?: { configPrefixes?: string[]; noopPrefixes?: string[] };
    gatewayMethods?: string[];
    configSchema?: any;
    config: {
      listAccountIds: (cfg: any) => string[];
      resolveAccount: (cfg: any, accountId?: string) => T;
      defaultAccountId: (cfg: any) => string;
      setAccountEnabled: (params: { cfg: any; accountId?: string; enabled: boolean }) => any;
      deleteAccount: (params: { cfg: any; accountId?: string }) => any;
      isEnabled?: (account: T, cfg: any) => boolean;
      disabledReason?: () => string;
      isConfigured?: (account: T) => boolean | Promise<boolean>;
      unconfiguredReason?: () => string;
      describeAccount: (account: T) => any;
      resolveAllowFrom: (params: { cfg: any; accountId?: string }) => string[];
      formatAllowFrom: (params: { allowFrom: string[] }) => string[];
    };
    security?: {
      resolveDmPolicy: (params: { cfg: any; accountId?: string; account: T }) => any;
      collectWarnings: (params: { account: T; cfg: any }) => string[];
    };
    groups?: {
      resolveRequireMention?: (params: { cfg: any; accountId?: string }) => boolean;
      resolveToolPolicy?: (params: { cfg: any; accountId?: string }) => string;
      resolveGroupIntroHint?: () => string;
    };
    mentions?: {
      stripPatterns: (params?: { ctx?: any }) => string[];
    };
    commands?: any;
    messaging?: {
      normalizeTarget?: (target: string) => string | null;
      targetResolver?: {
        looksLikeId: (input: string) => boolean;
        hint: string;
      };
    };
    directory?: {
      self?: (params: { cfg: any; accountId?: string }) => Promise<any>;
      listPeers?: (params: any) => Promise<any[]>;
      listGroups?: (params: any) => Promise<any[]>;
      listPeersLive?: (params: any) => Promise<any[]>;
      listGroupsLive?: (params: any) => Promise<any[]>;
    };
    resolver?: any;
    actions?: {
      listActions: (params: { cfg: any }) => string[];
      supportsAction?: (params: { action: string }) => boolean;
      extractToolSend?: (ctx: any) => any;
      handleAction?: (params: { action: string; params: any; cfg: any; accountId?: string }) => Promise<any>;
    };
    setup?: any;
    outbound: {
      deliveryMode: "direct" | "gateway";
      chunker?: ((text: string, limit: number) => string[]) | null;
      chunkerMode?: string;
      textChunkLimit?: number;
      pollMaxOptions?: number;
      resolveTarget?: (params: any) => any;
      sendText: (params: {
        to: string;
        text: string;
        accountId?: string;
        deps?: any;
        replyToId?: string;
        gifPlayback?: boolean;
      }) => Promise<any>;
      sendMedia?: (params: {
        to: string;
        text: string;
        mediaUrl: string;
        accountId?: string;
        deps?: any;
        replyToId?: string;
        gifPlayback?: boolean;
      }) => Promise<any>;
      sendPoll?: (params: { to: string; poll: any; accountId?: string }) => Promise<any>;
    };
    auth?: any;
    heartbeat?: any;
    status?: {
      defaultRuntime: any;
      collectStatusIssues?: (params: { account: T }) => Array<{ level: string; message: string }>;
      buildChannelSummary?: (params: { account?: T; snapshot: any }) => any;
      buildAccountSnapshot?: (params: { account: T; runtime?: any; probe?: any; audit?: any }) => any;
      resolveAccountState?: (params: { configured: boolean }) => string;
      logSelfId?: (params: { account: T; runtime: any; includeChannelPrefix: boolean }) => void;
      probeAccount?: (params: any) => Promise<any>;
      auditAccount?: (params: any) => Promise<any>;
    };
    threading?: any;
    gateway?: {
      startAccount?: (ctx: any) => Promise<void | any>;
      loginWithQrStart?: (params: any) => Promise<any>;
      loginWithQrWait?: (params: any) => Promise<any>;
      logoutAccount?: (params: any) => Promise<any>;
    };
  }

  export const DEFAULT_ACCOUNT_ID: string;
  export function normalizeAccountId(accountId?: string): string;
  export function emptyPluginConfigSchema(): any;
  export function getChatChannelMeta(id: string): any;
  export function buildChannelConfigSchema(schema: any): any;
  export function formatPairingApproveHint(channel: string): string;
  export function applyAccountNameToChannelSection(params: any): any;
  export function migrateBaseNameToDefaultAccount(params: any): any;
  export function createActionGate(config: any): (action: string) => boolean;
  export function readStringParam(params: any, key: string, opts?: any): string | undefined;
  export function readNumberParam(params: any, key: string, opts?: any): number | undefined;
  export function missingTargetError(channel: string, hint: string): string;
}
