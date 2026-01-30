import type { ChannelPlugin, ChannelMessageActionAdapter } from "clawdbot/plugin-sdk";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId, getChatChannelMeta } from "clawdbot/plugin-sdk";
import { DiscordUserClient, type DiscordUserAccount } from "./client.js";
import { createRequire } from "node:module";

// Dynamic import of Clawdbot internals (may break on version updates)
let dispatchInboundMessage: ((params: any) => Promise<any>) | null = null;
let createReplyDispatcherWithTyping: ((params: any) => any) | null = null;
let buildAgentPeerSessionKey: ((params: any) => string) | null = null;
let loadConfig: (() => any) | null = null;
let clawdbotBasePath: string = "";

async function initDispatch() {
  try {
    const require = createRequire(import.meta.url);
    const clawdbotPath = require.resolve("clawdbot");
    clawdbotBasePath = clawdbotPath.replace(/\/dist\/.*$/, "");
    
    const dispatchMod = await import(`${clawdbotBasePath}/dist/auto-reply/dispatch.js`);
    dispatchInboundMessage = dispatchMod.dispatchInboundMessage;
    
    const dispatcherMod = await import(`${clawdbotBasePath}/dist/auto-reply/reply/reply-dispatcher.js`);
    createReplyDispatcherWithTyping = dispatcherMod.createReplyDispatcherWithTyping;
    
    const sessionKeyMod = await import(`${clawdbotBasePath}/dist/routing/session-key.js`);
    buildAgentPeerSessionKey = sessionKeyMod.buildAgentPeerSessionKey;
    
    const configMod = await import(`${clawdbotBasePath}/dist/config/config.js`);
    loadConfig = configMod.loadConfig;
    
    console.log("[discord-user] Successfully loaded Clawdbot dispatch functions");
  } catch (err) {
    console.error("[discord-user] Failed to load Clawdbot dispatch functions:", err);
  }
}

// Initialize on module load
initDispatch();

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
    if (cfg.channels?.["discord-user"]?.token || process.env.DISCORD_USER_TOKEN) {
      return [DEFAULT_ACCOUNT_ID];
    }
    return [];
  }
  const ids = Object.keys(accounts);
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

const meta = getChatChannelMeta("discord");

export const discordUserPlugin: ChannelPlugin<ResolvedDiscordUserAccount> = {
  id: "discord-user",
  meta: {
    ...meta,
    id: "discord-user",
    label: "Discord User",
    selectionLabel: "Discord (User Account)",
    blurb: "Discord user account (selfbot) integration - act as a real Discord user.",
    aliases: ["discord-selfbot", "discorduser"],
  },
  capabilities: {
    chatTypes: ["direct", "channel", "thread"],
    polls: false, 
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
    listAccountIds: (cfg: any) => listDiscordUserAccountIds(cfg),
    resolveAccount: (cfg: any, accountId: string) => resolveDiscordUserAccount({ cfg, accountId }),
    defaultAccountId: (cfg: any) => resolveDefaultDiscordUserAccountId(cfg),
    setAccountEnabled: ({ cfg, accountId, enabled }: any) => {
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
    deleteAccount: ({ cfg, accountId }: any) => {
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
    isConfigured: (account: any) => Boolean(account.token?.trim()),
    describeAccount: (account: any) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: Boolean(account.token?.trim()),
      tokenSource: account.tokenSource,
    }),
    resolveAllowFrom: ({ cfg, accountId }: any) =>
      resolveDiscordUserAccount({ cfg, accountId }).config.allowFrom ?? [],
    formatAllowFrom: ({ allowFrom }: any) =>
      allowFrom
        .map((entry: any) => String(entry).trim())
        .filter(Boolean)
        .map((entry: any) => entry.toLowerCase()),
  },
  security: {
    resolveDmPolicy: ({ cfg, accountId, account }: any) => {
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
        normalizeEntry: (raw: string) => raw.replace(/^(discord-user|user):/i, "").replace(/^<@!?(\d+)>$/, "$1"),
      };
    },
    collectWarnings: ({ account, cfg }: any) => {
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
    resolveRequireMention: ({ cfg, accountId }: any) => {
      const account = resolveDiscordUserAccount({ cfg, accountId });
      return account.config.groupPolicy !== "open";
    },
    resolveToolPolicy: ({ cfg, accountId }: any) => {
      const account = resolveDiscordUserAccount({ cfg, accountId });
      return account.config.groupPolicy === "open" ? "full" : "default";
    },
  },
  mentions: {
    stripPatterns: () => ["<@!?\\d+>"],
  },
  messaging: {
    normalizeTarget: (target: string) => {
      if (!target) return null;
      const trimmed = target.trim();
      if (trimmed.startsWith("user:") || trimmed.startsWith("channel:")) {
        return trimmed;
      }
      if (/^\d{17,20}$/.test(trimmed)) {
        return trimmed;
      }
      return null;
    },
    targetResolver: {
      looksLikeId: (input: string) => /^\d{17,20}$/.test(input) || /^(user|channel):\d{17,20}$/.test(input),
      hint: "<channelId|user:ID|channel:ID>",
    },
  },
  directory: {
    self: async ({ cfg, accountId }: any) => {
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
    listActions: () => ["react", "setStatus", "addFriend", "removeFriend", "leaveGuild", "listGuilds", "joinGuild"],
    supportsAction: ({ action }: any) => ["react", "setStatus", "addFriend", "removeFriend", "leaveGuild", "listGuilds", "joinGuild"].includes(action),
    handleAction: async ({ action, params, cfg, accountId }: any) => {
      const account = resolveDiscordUserAccount({ cfg, accountId });
      const client = clients.get(account.accountId);
      if (!client) {
        return { ok: false, error: "Discord user client not running" };
      }

      try {
        if (action === "react") {
          const channelId = params.channelId || params.to;
          const messageId = params.messageId;
          const emoji = params.emoji;
          const remove = params.remove === true;

          if (!channelId || !messageId) {
            return { ok: false, error: "Missing channelId or messageId" };
          }
          await client.react(channelId, messageId, emoji, remove);
          return { ok: true };
        }
        
        if (action === "setStatus") {
            const status = params.status || params.text;
            const type = params.type || "PLAYING";
            if (!status) return { ok: false, error: "Missing status text" };
            await client.setStatus(status, type);
            return { ok: true };
        }

        if (action === "addFriend") {
            const userId = params.userId || params.to;
            if (!userId) return { ok: false, error: "Missing userId" };
            await client.acceptFriendRequest(userId);
            return { ok: true };
        }

        if (action === "removeFriend") {
             const userId = params.userId || params.to;
             if (!userId) return { ok: false, error: "Missing userId" };
             await client.removeFriend(userId);
             return { ok: true };
        }

        if (action === "leaveGuild") {
             const guildId = params.guildId;
             if (!guildId) return { ok: false, error: "Missing guildId" };
             await client.leaveGuild(guildId);
             return { ok: true };
        }
        
        if (action === "listGuilds") {
            const guilds = await client.getGuilds();
            return { ok: true, data: guilds };
        }

        if (action === "joinGuild") {
            const inviteCode = params.inviteCode || params.code || params.invite;
            if (!inviteCode) return { ok: false, error: "Missing inviteCode" };
            await client.joinGuild(inviteCode);
            return { ok: true };
        }

        throw new Error(`Action ${action} is not supported for discord-user.`);
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    },
  },
  outbound: {
    deliveryMode: "direct",
    chunker: null,
    textChunkLimit: 2000,
    sendText: async ({ to, text, accountId, replyToId }: any) => {
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
    sendMedia: async ({ to, text, mediaUrl, accountId, replyToId }: any) => {
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
    collectStatusIssues: (params: any) => {
      const issues: Array<{ level: "error" | "warn" | "info"; message: string }> = [];
      const account = params?.account;
      if (!account?.token) {
        issues.push({
          level: "error",
          message: "No token configured. Set channels.discord-user.token or DISCORD_USER_TOKEN env var.",
        });
      }
      return issues;
    },
    buildChannelSummary: ({ snapshot }: any) => ({
      configured: snapshot.configured ?? false,
      tokenSource: snapshot.tokenSource ?? "none",
      running: snapshot.running ?? false,
      connected: snapshot.connected ?? false,
      lastConnectedAt: snapshot.lastConnectedAt ?? null,
      lastError: snapshot.lastError ?? null,
    }),
    probeAccount: async ({ account }: any) => {
        if (!account.token) return { ok: false, error: "missing token" };
        const dummyClient = new DiscordUserClient({ token: account.token } as any);
        return await dummyClient.probe(account.token);
    },
    buildAccountSnapshot: ({ account, runtime, probe }: any) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: Boolean(account.token?.trim()),
      tokenSource: account.tokenSource,
      running: runtime?.running ?? false,
      connected: runtime?.connected ?? false,
      lastConnectedAt: runtime?.lastConnectedAt ?? null,
      lastError: runtime?.lastError ?? null,
      probe,
    }),
  },
  gateway: {
    startAccount: async (ctx: any) => {
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
          if (!dispatchInboundMessage || !createReplyDispatcherWithTyping || !buildAgentPeerSessionKey) {
            return;
          }
          
          try {
            const cfg = loadConfig?.() ?? ctx.cfg;
            const client = clients.get(account.accountId);

            const isDM = message.isDM;
            const wasMentioned = message.mentions?.some((m: any) => m.id === client?.user?.id) ?? false;
            
            if (!isDM && !wasMentioned) {
              return;
            }
            
            const peerKind = message.isDM ? "dm" : message.isThread ? "thread" : "channel";
            const peerId = message.isDM ? message.authorId : message.channelId;
            
            const sessionKey = buildAgentPeerSessionKey({
              agentId: "main",
              mainKey: "main",
              channel: "discord-user",
              peerKind: peerKind,
              peerId: peerId,
              dmScope: "per-channel-peer",
            });
            
            const inboundCtx: Record<string, any> = {
              SessionKey: sessionKey,
              Provider: "discord-user",
              Surface: "discord-user",
              AccountId: account.accountId,
              Body: message.content,
              RawBody: message.content,
              BodyForAgent: message.content,
              BodyForCommands: message.content,
              ChatType: peerKind === "dm" ? "direct" : peerKind,
              To: message.channelId,
              From: message.authorId,
              FromName: message.authorName,
              FromTag: message.authorTag,
              MessageSid: message.id,
              Timestamp: message.timestamp,
              GuildId: message.guildId,
              GuildName: message.guildName,
              ChannelId: message.channelId,
              ChannelName: message.channelName,
              ReplyToId: message.replyToId,
              IsThread: message.isThread,
              Mentions: message.mentions,
              WasMentioned: wasMentioned,
              CommandAuthorized: message.isDM || wasMentioned,
              MediaUrls: message.attachments?.map((a: any) => a.url) ?? [],
              Attachments: message.attachments,
              IsBot: message.isBot,
            };
            
            let thinkingMessageId: string | undefined;

            const { dispatcher, replyOptions, markDispatchIdle } = createReplyDispatcherWithTyping({
              deliver: async (payload: { text?: string; mediaUrls?: string[]; mediaUrl?: string }) => {
                try {
                  if (thinkingMessageId) {
                    try {
                      await client?.deleteMessage(message.channelId, thinkingMessageId);
                      thinkingMessageId = undefined;
                    } catch (e) {}
                  }

                  if (payload.text) {
                    await client?.sendMessage(message.channelId, payload.text, {
                      replyTo: message.id,
                    });
                  }
                  
                  if (payload.mediaUrls) {
                    for (const url of payload.mediaUrls) {
                      await client?.sendMessage(message.channelId, "", {
                        replyTo: message.id,
                        mediaUrl: url,
                      });
                    }
                  } else if (payload.mediaUrl) {
                    await client?.sendMessage(message.channelId, "", {
                      replyTo: message.id,
                      mediaUrl: payload.mediaUrl,
                    });
                  }
                } catch (deliverErr) {
                  ctx.log?.error(`[${account.accountId}] Failed to send message: ${deliverErr}`);
                  throw deliverErr;
                }
              },
              onTypingStart: async () => {
                try {
                    await client?.typing(message.channelId);
                    const botName = client?.user?.username || "AI";
                    const result = await client?.sendMessage(message.channelId, `*${botName}님이 입력중입니다...*`);
                    thinkingMessageId = (result as any).id;
                } catch (e) {}
              },
              onTypingStop: async () => {
                if (thinkingMessageId) {
                    try {
                      await client?.deleteMessage(message.channelId, thinkingMessageId);
                      thinkingMessageId = undefined;
                    } catch (e) {}
                }
              },
              onError: (err: unknown, info: { kind: string }) => {
                ctx.log?.error(`[${account.accountId}] Reply error (${info.kind}): ${err}`);
              },
            });
            
            await dispatchInboundMessage({
              ctx: inboundCtx,
              cfg,
              dispatcher,
              replyOptions,
            });
            
            markDispatchIdle();
          } catch (err) {
            ctx.log?.error(`[${account.accountId}] Dispatch failed: ${err}`);
          }
        },
        onReady: (user: any) => {
          ctx.log?.info(`[${account.accountId}] Connected as ${user.tag} (${user.id})`);
          ctx.setStatus({
            accountId: account.accountId,
            running: true,
            connected: true,
            lastConnectedAt: new Date().toISOString(),
            user: { id: user.id, tag: user.tag },
          });
        },
        onError: (error: any) => {
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
      await client.start();

      ctx.abortSignal?.addEventListener("abort", () => {
        client.stop();
        clients.delete(account.accountId);
      });

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


