import type { ChannelPlugin } from "clawdbot/plugin-sdk";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "clawdbot/plugin-sdk";
import { getDiscordUserRuntime } from "./runtime.js";
import { DiscordUserClient, type DiscordUserAccount } from "./client.js";

// Active client instances per account
const clients = new Map<string, DiscordUserClient>();

export interface ResolvedDiscordUserAccount {
  accountId: string;
  name?: string;
  enabled: boolean;
  token?: string;
  tokenSource: "config" | "env" | "none";
  config: {
    dmPolicy?: "open" | "pairing" | "allowlist";
    allowFrom?: string[];
    groupPolicy?: "open" | "allowlist";
    guilds?: Record<string, { enabled?: boolean; channels?: Record<string, boolean> }>;
    mediaMaxMb?: number;
    historyLimit?: number;
  };
}

function listDiscordUserAccountIds(cfg: any): string[] {
  const accounts = cfg.channels?.["discord-user"]?.accounts;
  if (!accounts || typeof accounts !== "object") {
    // Check for top-level token
    if (cfg.channels?.["discord-user"]?.token || process.env.DISCORD_USER_TOKEN) {
      return [DEFAULT_ACCOUNT_ID];
    }
    return [];
  }
  const ids = Object.keys(accounts);
  // Include default if top-level token exists
  if (
    !ids.includes(DEFAULT_ACCOUNT_ID) &&
    (cfg.channels?.["discord-user"]?.token || process.env.DISCORD_USER_TOKEN)
  ) {
    ids.unshift(DEFAULT_ACCOUNT_ID);
  }
  return ids;
}

function resolveDiscordUserAccount(params: {
  cfg: any;
  accountId?: string;
}): ResolvedDiscordUserAccount {
  const { cfg, accountId } = params;
  const resolvedId = accountId || DEFAULT_ACCOUNT_ID;
  const channelCfg = cfg.channels?.["discord-user"] ?? {};
  const accountCfg = channelCfg.accounts?.[resolvedId] ?? {};

  // For default account, check top-level and env
  let token: string | undefined;
  let tokenSource: "config" | "env" | "none" = "none";

  if (resolvedId === DEFAULT_ACCOUNT_ID) {
    if (channelCfg.token) {
      token = channelCfg.token;
      tokenSource = "config";
    } else if (process.env.DISCORD_USER_TOKEN) {
      token = process.env.DISCORD_USER_TOKEN;
      tokenSource = "env";
    }
  } else {
    if (accountCfg.token) {
      token = accountCfg.token;
      tokenSource = "config";
    }
  }

  return {
    accountId: resolvedId,
    name: accountCfg.name ?? channelCfg.name,
    enabled: accountCfg.enabled !== false && channelCfg.enabled !== false,
    token,
    tokenSource,
    config: {
      dmPolicy: accountCfg.dmPolicy ?? channelCfg.dmPolicy ?? "pairing",
      allowFrom: accountCfg.allowFrom ?? channelCfg.allowFrom ?? [],
      groupPolicy: accountCfg.groupPolicy ?? channelCfg.groupPolicy ?? "allowlist",
      guilds: accountCfg.guilds ?? channelCfg.guilds,
      mediaMaxMb: accountCfg.mediaMaxMb ?? channelCfg.mediaMaxMb ?? 25,
      historyLimit: accountCfg.historyLimit ?? channelCfg.historyLimit ?? 10,
    },
  };
}

function resolveDefaultDiscordUserAccountId(cfg: any): string {
  const ids = listDiscordUserAccountIds(cfg);
  return ids[0] ?? DEFAULT_ACCOUNT_ID;
}

export const discordUserPlugin: ChannelPlugin<ResolvedDiscordUserAccount> = {
  id: "discord-user",
  meta: {
    id: "discord-user",
    label: "Discord User",
    selectionLabel: "Discord (User Account)",
    docsPath: "/plugins/discord-user",
    docsLabel: "discord-user",
    blurb: "Discord user account (selfbot) integration - act as a real Discord user.",
    aliases: ["discord-selfbot", "discorduser"],
  },
  capabilities: {
    chatTypes: ["direct", "channel", "thread"],
    polls: false, // User accounts can't create polls
    reactions: true,
    threads: true,
    media: true,
    nativeCommands: false,
  },
  streaming: {
    blockStreamingCoalesceDefaults: { minChars: 1500, idleMs: 1000 },
  },
  reload: { configPrefixes: ["channels.discord-user"] },
  config: {
    listAccountIds: (cfg) => listDiscordUserAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveDiscordUserAccount({ cfg, accountId }),
    defaultAccountId: (cfg) => resolveDefaultDiscordUserAccountId(cfg),
    setAccountEnabled: ({ cfg, accountId, enabled }) => {
      const accountKey = accountId || DEFAULT_ACCOUNT_ID;
      const accounts = { ...cfg.channels?.["discord-user"]?.accounts };
      const existing = accounts[accountKey] ?? {};
      return {
        ...cfg,
        channels: {
          ...cfg.channels,
          "discord-user": {
            ...cfg.channels?.["discord-user"],
            accounts: {
              ...accounts,
              [accountKey]: {
                ...existing,
                enabled,
              },
            },
          },
        },
      };
    },
    deleteAccount: ({ cfg, accountId }) => {
      const accountKey = accountId || DEFAULT_ACCOUNT_ID;
      const accounts = { ...cfg.channels?.["discord-user"]?.accounts };
      delete accounts[accountKey];
      return {
        ...cfg,
        channels: {
          ...cfg.channels,
          "discord-user": {
            ...cfg.channels?.["discord-user"],
            accounts: Object.keys(accounts).length ? accounts : undefined,
          },
        },
      };
    },
    isConfigured: (account) => Boolean(account.token?.trim()),
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: Boolean(account.token?.trim()),
      tokenSource: account.tokenSource,
    }),
    resolveAllowFrom: ({ cfg, accountId }) =>
      resolveDiscordUserAccount({ cfg, accountId }).config.allowFrom ?? [],
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom
        .map((entry) => String(entry).trim())
        .filter(Boolean)
        .map((entry) => entry.toLowerCase()),
  },
  security: {
    resolveDmPolicy: ({ cfg, accountId, account }) => {
      const resolvedAccountId = accountId ?? account.accountId ?? DEFAULT_ACCOUNT_ID;
      const useAccountPath = Boolean(cfg.channels?.["discord-user"]?.accounts?.[resolvedAccountId]);
      const allowFromPath = useAccountPath
        ? `channels.discord-user.accounts.${resolvedAccountId}.`
        : "channels.discord-user.";
      return {
        policy: account.config.dmPolicy ?? "pairing",
        allowFrom: account.config.allowFrom ?? [],
        allowFromPath,
        approveHint: `Add user ID to channels.discord-user.allowFrom or use /approve discord-user:<userId>`,
        normalizeEntry: (raw) => raw.replace(/^(discord-user|user):/i, "").replace(/^<@!?(\d+)>$/, "$1"),
      };
    },
    collectWarnings: ({ account, cfg }) => {
      const warnings: string[] = [];
      const defaultGroupPolicy = cfg.channels?.defaults?.groupPolicy;
      const groupPolicy = account.config.groupPolicy ?? defaultGroupPolicy ?? "allowlist";

      if (groupPolicy === "open") {
        warnings.push(
          `- Discord User: groupPolicy="open" allows any channel to trigger (mention-gated). Consider setting channels.discord-user.groupPolicy="allowlist".`
        );
      }

      return warnings;
    },
  },
  groups: {
    resolveRequireMention: ({ cfg, accountId }) => {
      const account = resolveDiscordUserAccount({ cfg, accountId });
      return account.config.groupPolicy !== "open";
    },
    resolveToolPolicy: ({ cfg, accountId }) => {
      const account = resolveDiscordUserAccount({ cfg, accountId });
      return account.config.groupPolicy === "open" ? "full" : "default";
    },
  },
  mentions: {
    stripPatterns: () => ["<@!?\\d+>"],
  },
  messaging: {
    normalizeTarget: (target) => {
      if (!target) return null;
      const trimmed = target.trim();
      // Handle user:ID or channel:ID format
      if (trimmed.startsWith("user:") || trimmed.startsWith("channel:")) {
        return trimmed;
      }
      // Handle raw IDs (snowflakes)
      if (/^\d{17,20}$/.test(trimmed)) {
        return trimmed;
      }
      return null;
    },
    targetResolver: {
      looksLikeId: (input) => /^\d{17,20}$/.test(input) || /^(user|channel):\d{17,20}$/.test(input),
      hint: "<channelId|user:ID|channel:ID>",
    },
  },
  directory: {
    self: async ({ cfg, accountId }) => {
      const account = resolveDiscordUserAccount({ cfg, accountId });
      const client = clients.get(account.accountId);
      if (!client?.user) return null;
      return {
        kind: "user",
        id: client.user.id,
        name: client.user.username,
        raw: { tag: client.user.tag },
      };
    },
    listPeers: async () => [],
    listGroups: async () => [],
  },
  actions: {
    listActions: () => ["react"],
    supportsAction: ({ action }) => action === "react",
    handleAction: async ({ action, params, cfg, accountId }) => {
      if (action !== "react") {
        throw new Error(`Action ${action} is not supported for discord-user.`);
      }
      const account = resolveDiscordUserAccount({ cfg, accountId });
      const client = clients.get(account.accountId);
      if (!client) {
        return { ok: false, error: "Discord user client not running" };
      }

      const channelId = params.channelId || params.to;
      const messageId = params.messageId;
      const emoji = params.emoji;
      const remove = params.remove === true;

      if (!channelId || !messageId) {
        return { ok: false, error: "Missing channelId or messageId" };
      }

      try {
        await client.react(channelId, messageId, emoji, remove);
        return { ok: true };
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    },
  },
  outbound: {
    deliveryMode: "direct",
    chunker: null,
    textChunkLimit: 2000,
    sendText: async ({ to, text, accountId, replyToId }) => {
      const client = clients.get(accountId ?? DEFAULT_ACCOUNT_ID);
      if (!client) {
        return { channel: "discord-user", ok: false, error: "Client not running" };
      }
      try {
        const result = await client.sendMessage(to, text, { replyTo: replyToId });
        return { channel: "discord-user", ok: true, messageId: result.id };
      } catch (err) {
        return { channel: "discord-user", ok: false, error: String(err) };
      }
    },
    sendMedia: async ({ to, text, mediaUrl, accountId, replyToId }) => {
      const client = clients.get(accountId ?? DEFAULT_ACCOUNT_ID);
      if (!client) {
        return { channel: "discord-user", ok: false, error: "Client not running" };
      }
      try {
        const result = await client.sendMessage(to, text, { 
          replyTo: replyToId,
          mediaUrl,
        });
        return { channel: "discord-user", ok: true, messageId: result.id };
      } catch (err) {
        return { channel: "discord-user", ok: false, error: String(err) };
      }
    },
  },
  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      connected: false,
      lastConnectedAt: null,
      lastError: null,
    },
    collectStatusIssues: ({ account }) => {
      const issues: Array<{ level: "error" | "warn" | "info"; message: string }> = [];
      if (!account.token) {
        issues.push({
          level: "error",
          message: "No token configured. Set channels.discord-user.token or DISCORD_USER_TOKEN env var.",
        });
      }
      return issues;
    },
    buildChannelSummary: ({ snapshot }) => ({
      configured: snapshot.configured ?? false,
      tokenSource: snapshot.tokenSource ?? "none",
      running: snapshot.running ?? false,
      connected: snapshot.connected ?? false,
      lastConnectedAt: snapshot.lastConnectedAt ?? null,
      lastError: snapshot.lastError ?? null,
    }),
    buildAccountSnapshot: ({ account, runtime }) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: Boolean(account.token?.trim()),
      tokenSource: account.tokenSource,
      running: runtime?.running ?? false,
      connected: runtime?.connected ?? false,
      lastConnectedAt: runtime?.lastConnectedAt ?? null,
      lastError: runtime?.lastError ?? null,
    }),
  },
  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      const token = account.token?.trim();

      if (!token) {
        throw new Error("No Discord user token configured");
      }

      ctx.log?.info(`[${account.accountId}] Starting Discord user client...`);

      const client = new DiscordUserClient({
        token,
        accountId: account.accountId,
        config: ctx.cfg,
        runtime: ctx.runtime,
        onMessage: async (message) => {
          // Forward to Clawdbot's message handler
          const runtime = getDiscordUserRuntime();
          if (runtime?.gateway?.handleInboundMessage) {
            await runtime.gateway.handleInboundMessage({
              channel: "discord-user",
              accountId: account.accountId,
              message,
            });
          }
        },
        onReady: (user) => {
          ctx.log?.info(`[${account.accountId}] Connected as ${user.tag} (${user.id})`);
          ctx.setStatus({
            accountId: account.accountId,
            running: true,
            connected: true,
            lastConnectedAt: new Date().toISOString(),
            user: { id: user.id, tag: user.tag },
          });
        },
        onError: (error) => {
          ctx.log?.error(`[${account.accountId}] Error: ${error}`);
          ctx.setStatus({
            accountId: account.accountId,
            lastError: String(error),
          });
        },
        onDisconnect: () => {
          ctx.log?.warn(`[${account.accountId}] Disconnected`);
          ctx.setStatus({
            accountId: account.accountId,
            connected: false,
          });
        },
      });

      clients.set(account.accountId, client);

      // Start the client
      await client.start();

      // Handle abort signal
      ctx.abortSignal?.addEventListener("abort", () => {
        ctx.log?.info(`[${account.accountId}] Stopping Discord user client...`);
        client.stop();
        clients.delete(account.accountId);
      });

      // Return a promise that resolves when the client stops
      return new Promise<void>((resolve) => {
        const checkInterval = setInterval(() => {
          if (!client.isRunning) {
            clearInterval(checkInterval);
            clients.delete(account.accountId);
            resolve();
          }
        }, 1000);
      });
    },
  },
};
