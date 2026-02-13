import type { ChannelPlugin, ChannelMessageActionAdapter } from "openclaw/plugin-sdk";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId, getChatChannelMeta } from "openclaw/plugin-sdk";
import { DiscordUserClient, type DiscordUserAccount } from "./client.js";
import { createRequire } from "node:module";

// Dynamic import of openclaw internals (may break on version updates)
let dispatchInboundMessage: ((params: any) => Promise<any>) | null = null;
let createReplyDispatcherWithTyping: ((params: any) => any) | null = null;
let buildAgentPeerSessionKey: ((params: any) => string) | null = null;
let loadConfig: (() => any) | null = null;
let openclawBasePath: string = "";

async function initDispatch() {
  try {
    const require = createRequire(import.meta.url);
    const openclawPath = require.resolve("openclaw");
    openclawBasePath = openclawPath.replace(/\/dist\/.*$/, "");
    
    const dispatchMod = await import(`${openclawBasePath}/dist/auto-reply/dispatch.js`);
    dispatchInboundMessage = dispatchMod.dispatchInboundMessage;
    
    const dispatcherMod = await import(`${openclawBasePath}/dist/auto-reply/reply/reply-dispatcher.js`);
    createReplyDispatcherWithTyping = dispatcherMod.createReplyDispatcherWithTyping;
    
    const sessionKeyMod = await import(`${openclawBasePath}/dist/routing/session-key.js`);
    buildAgentPeerSessionKey = sessionKeyMod.buildAgentPeerSessionKey;
    
    const configMod = await import(`${openclawBasePath}/dist/config/config.js`);
    loadConfig = configMod.loadConfig;
    
    console.log("[discord-user] Successfully loaded openclaw dispatch functions");
  } catch (err) {
    console.error("[discord-user] Failed to load openclaw dispatch functions:", err);
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
    groupPolicy?: "open" | "allowlist" | "disabled";
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

function resolveDefaultAgentId(cfg: any): string {
  const agents = cfg?.agents?.list;
  if (Array.isArray(agents)) {
    const defaultAgent = agents.find((entry: any) => entry?.default === true && typeof entry?.id === "string");
    if (defaultAgent?.id) {
      return defaultAgent.id;
    }

    const firstAgent = agents.find((entry: any) => typeof entry?.id === "string");
    if (firstAgent?.id) {
      return firstAgent.id;
    }
  }

  return "main";
}

type DiscordUserGroupPolicy = "open" | "allowlist" | "disabled";
type DiscordUserGuildMap = Record<string, { enabled?: boolean; channels?: Record<string, boolean> }>;

function normalizeDiscordUserId(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed === "*") return null;
  const mention = trimmed.match(/^<@!?(\d+)>$/);
  const cleaned = (mention?.[1] ?? trimmed)
    .replace(/^(discord-user|discord|user):/i, "")
    .trim();
  return /^\d+$/.test(cleaned) ? cleaned : null;
}

function normalizeDiscordGuildKey(raw: string): string | "*" | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed === "*") return "*";
  const cleaned = trimmed.replace(/^(discord-user|discord|guild|server):/i, "").trim();
  if (cleaned === "*") return "*";
  return /^\d+$/.test(cleaned) ? cleaned : null;
}

function normalizeDiscordChannelKey(raw: string): string | "*" | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed === "*") return "*";
  const mention = trimmed.match(/^<#(\d+)>$/);
  const cleaned = (mention?.[1] ?? trimmed)
    .replace(/^(discord-user|discord|channel|group):/i, "")
    .trim();
  if (cleaned === "*") return "*";
  return /^\d+$/.test(cleaned) ? cleaned : null;
}

function resolveDiscordUserGroupPolicy(account: ResolvedDiscordUserAccount, cfg: any): DiscordUserGroupPolicy {
  const raw = account.config.groupPolicy ?? cfg.channels?.defaults?.groupPolicy ?? "allowlist";
  return raw === "open" || raw === "allowlist" || raw === "disabled" ? raw : "allowlist";
}

function resolveDiscordUserGuildEntry(
  guilds: DiscordUserGuildMap | undefined,
  guildId: string | undefined
): { enabled?: boolean; channels?: Record<string, boolean> } | null {
  if (!guilds || typeof guilds !== "object") return null;
  if (guildId && guilds[guildId]) return guilds[guildId];

  let wildcardEntry: { enabled?: boolean; channels?: Record<string, boolean> } | null = null;
  for (const [rawKey, entry] of Object.entries(guilds)) {
    const normalized = normalizeDiscordGuildKey(rawKey);
    if (!normalized) continue;
    if (normalized === "*" && wildcardEntry == null) {
      wildcardEntry = entry;
      continue;
    }
    if (guildId && normalized === guildId) {
      return entry;
    }
  }

  return wildcardEntry;
}

function resolveDiscordUserChannelAllowed(
  channels: Record<string, boolean> | undefined,
  channelId: string,
  fallback: boolean
): boolean {
  if (!channels || typeof channels !== "object" || Object.keys(channels).length === 0) {
    return fallback;
  }

  if (typeof channels[channelId] === "boolean") {
    return channels[channelId];
  }

  let wildcard: boolean | undefined;
  for (const [rawKey, allowed] of Object.entries(channels)) {
    if (typeof allowed !== "boolean") continue;
    const normalized = normalizeDiscordChannelKey(rawKey);
    if (!normalized) continue;
    if (normalized === channelId) return allowed;
    if (normalized === "*") wildcard = allowed;
  }

  if (typeof wildcard === "boolean") {
    return wildcard;
  }
  return fallback;
}

function isDiscordUserGuildMessageAllowed(params: {
  groupPolicy: DiscordUserGroupPolicy;
  guilds: DiscordUserGuildMap | undefined;
  guildId: string | undefined;
  channelId: string | undefined;
}): boolean {
  const { groupPolicy, guilds, guildId, channelId } = params;
  if (!guildId || !channelId) return false;

  if (groupPolicy === "disabled") {
    return false;
  }

  const guildConfigured = Boolean(guilds && Object.keys(guilds).length > 0);
  const guildEntry = resolveDiscordUserGuildEntry(guilds, guildId);
  const channelsConfigured = Boolean(guildEntry?.channels && Object.keys(guildEntry.channels).length > 0);

  if (groupPolicy === "open") {
    if (!guildEntry) return true;
    if (guildEntry.enabled === false) return false;
    return resolveDiscordUserChannelAllowed(guildEntry.channels, channelId, true);
  }

  if (!guildConfigured) return false;
  if (!guildEntry) return false;
  if (guildEntry.enabled === false) return false;
  if (!channelsConfigured) return true;
  return resolveDiscordUserChannelAllowed(guildEntry.channels, channelId, false);
}

async function listDiscordUserDirectoryPeersFromConfig(params: {
  cfg: any;
  accountId?: string;
  query?: string;
  limit?: number;
}): Promise<Array<{ kind: "user"; id: string }>> {
  const account = resolveDiscordUserAccount({ cfg: params.cfg, accountId: params.accountId });
  const q = params.query?.trim().toLowerCase() || "";

  const ids = new Set<string>();
  for (const entry of account.config.allowFrom ?? []) {
    const normalized = normalizeDiscordUserId(String(entry));
    if (normalized) {
      ids.add(`user:${normalized}`);
    }
  }

  return Array.from(ids)
    .filter((id) => (q ? id.toLowerCase().includes(q) : true))
    .slice(0, params.limit && params.limit > 0 ? params.limit : undefined)
    .map((id) => ({ kind: "user" as const, id }));
}

async function listDiscordUserDirectoryGroupsFromConfig(params: {
  cfg: any;
  accountId?: string;
  query?: string;
  limit?: number;
}): Promise<Array<{ kind: "group"; id: string }>> {
  const account = resolveDiscordUserAccount({ cfg: params.cfg, accountId: params.accountId });
  const q = params.query?.trim().toLowerCase() || "";

  const ids = new Set<string>();
  for (const guildEntry of Object.values(account.config.guilds ?? {})) {
    for (const [rawChannelId, enabled] of Object.entries(guildEntry?.channels ?? {})) {
      if (enabled === false) continue;
      const normalized = normalizeDiscordChannelKey(rawChannelId);
      if (!normalized || normalized === "*") continue;
      ids.add(`channel:${normalized}`);
    }
  }

  return Array.from(ids)
    .filter((id) => (q ? id.toLowerCase().includes(q) : true))
    .slice(0, params.limit && params.limit > 0 ? params.limit : undefined)
    .map((id) => ({ kind: "group" as const, id }));
}

function normalizeDiscordVoiceChannelTarget(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const mention = trimmed.match(/^<#(\d+)>$/);
  const cleaned = (mention?.[1] ?? trimmed).replace(/^channel:/i, "").trim();
  return /^\d{17,20}$/.test(cleaned) ? cleaned : null;
}

function normalizeDiscordGuildTarget(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const cleaned = raw.trim().replace(/^(discord-user|discord|guild|server):/i, "").trim();
  return /^\d{17,20}$/.test(cleaned) ? cleaned : null;
}

function normalizeDiscordUserTarget(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const mention = raw.trim().match(/^<@!?(\d+)>$/);
  const cleaned = (mention?.[1] ?? raw.trim())
    .replace(/^(discord-user|discord|user):/i, "")
    .trim();
  return /^\d{17,20}$/.test(cleaned) ? cleaned : null;
}

function normalizeDiscordRoleTarget(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const mention = raw.trim().match(/^<@&(\d+)>$/);
  const cleaned = (mention?.[1] ?? raw.trim())
    .replace(/^(discord-user|discord|role):/i, "")
    .trim();
  return /^\d{17,20}$/.test(cleaned) ? cleaned : null;
}

function normalizeDiscordChannelTarget(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const mention = raw.trim().match(/^<#(\d+)>$/);
  const cleaned = (mention?.[1] ?? raw.trim())
    .replace(/^(discord-user|discord|channel|group):/i, "")
    .trim();
  return /^\d{17,20}$/.test(cleaned) ? cleaned : null;
}

function readOptionalNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function readOptionalText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function readRoleIdList(value: unknown): string[] {
  const rawItems = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : [];

  const parsed = rawItems
    .map((entry) => normalizeDiscordRoleTarget(String(entry)))
    .filter((entry): entry is string => Boolean(entry));
  return Array.from(new Set(parsed));
}

function normalizeDiscordGuildChannelType(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return undefined;

  const byAlias: Record<string, string> = {
    text: "GUILD_TEXT",
    news: "GUILD_NEWS",
    announcement: "GUILD_NEWS",
    voice: "GUILD_VOICE",
    stage: "GUILD_STAGE_VOICE",
    stage_voice: "GUILD_STAGE_VOICE",
    stagevoice: "GUILD_STAGE_VOICE",
    category: "GUILD_CATEGORY",
    forum: "GUILD_FORUM",
    media: "GUILD_MEDIA",
    guild_text: "GUILD_TEXT",
    guild_news: "GUILD_NEWS",
    guild_voice: "GUILD_VOICE",
    guild_stage_voice: "GUILD_STAGE_VOICE",
    guild_category: "GUILD_CATEGORY",
    guild_forum: "GUILD_FORUM",
    guild_media: "GUILD_MEDIA",
  };
  return byAlias[normalized];
}

function resolveTimeoutDurationMs(params: any): number | null | undefined {
  if (params.clear === true || params.remove === true) {
    return null;
  }

  const durationMs = readOptionalNumber(params.durationMs);
  if (durationMs !== undefined) {
    return durationMs <= 0 ? null : durationMs;
  }

  const minutes = readOptionalNumber(params.minutes ?? params.durationMinutes);
  if (minutes !== undefined) {
    return minutes <= 0 ? null : Math.round(minutes * 60 * 1000);
  }

  const until = readOptionalText(params.until ?? params.untilAt);
  if (until) {
    const untilTs = Date.parse(until);
    if (!Number.isFinite(untilTs)) {
      return undefined;
    }
    const remaining = untilTs - Date.now();
    return remaining <= 0 ? null : remaining;
  }

  return undefined;
}

function readOptionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
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
      const groupPolicy = resolveDiscordUserGroupPolicy(account, cfg);
      const guildsConfigured = Boolean(account.config.guilds && Object.keys(account.config.guilds).length > 0);

      if (groupPolicy === "open") {
        if (guildsConfigured) {
          warnings.push(
            `- Discord User: groupPolicy="open" allows all guild channels by default. Only explicit enabled:false rules in channels.discord-user.guilds can block channels.`
          );
        } else {
          warnings.push(
            `- Discord User: groupPolicy="open" with no guild allowlist allows all guild channels to trigger. Set channels.discord-user.groupPolicy="allowlist" and configure channels.discord-user.guilds to restrict access.`
          );
        }
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
    listPeers: async ({ cfg, accountId, query, limit }: any) =>
      listDiscordUserDirectoryPeersFromConfig({ cfg, accountId, query, limit }),
    listGroups: async ({ cfg, accountId, query, limit }: any) =>
      listDiscordUserDirectoryGroupsFromConfig({ cfg, accountId, query, limit }),
  },
  actions: {
    listActions: () => [
      "react",
      "setStatus",
      "addFriend",
      "removeFriend",
      "callUser",
      "leaveGuild",
      "listGuilds",
      "joinGuild",
      "listRoles",
      "createRole",
      "editRole",
      "deleteRole",
      "addRoleToUser",
      "removeRoleFromUser",
      "setUserRoles",
      "setNickname",
      "kickUser",
      "banUser",
      "unbanUser",
      "timeoutUser",
      "listChannels",
      "createChannel",
      "editChannel",
      "deleteChannel",
      "voiceJoin",
      "voiceLeave",
      "voiceStatus",
      "setVoiceState",
      "editMessage",
      "deleteMessage",
      "typing",
      "fetchMessages",
      "fetchMessage",
      "getChannelInfo",
    ],
    supportsAction: ({ action }: any) =>
      [
        "react",
        "setStatus",
        "addFriend",
        "removeFriend",
        "callUser",
        "leaveGuild",
        "listGuilds",
        "joinGuild",
        "listRoles",
        "createRole",
        "editRole",
        "deleteRole",
        "addRoleToUser",
        "removeRoleFromUser",
        "setUserRoles",
        "setNickname",
        "kickUser",
        "banUser",
        "unbanUser",
        "timeoutUser",
        "listChannels",
        "createChannel",
        "editChannel",
        "deleteChannel",
        "voiceJoin",
        "voiceLeave",
        "voiceStatus",
        "setVoiceState",
        "editMessage",
        "deleteMessage",
        "typing",
        "fetchMessages",
        "fetchMessage",
        "getChannelInfo",
      ].includes(action),
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

        if (action === "callUser") {
          const userId = normalizeDiscordUserTarget(params.userId || params.to);
          if (!userId) return { ok: false, error: "Missing or invalid userId" };
          const data = await client.callUser(userId);
          return { ok: true, data };
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

        if (action === "listRoles") {
          const guildId = normalizeDiscordGuildTarget(params.guildId);
          if (!guildId) return { ok: false, error: "Missing or invalid guildId" };
          const data = await client.listRoles(guildId);
          return { ok: true, data };
        }

        if (action === "createRole") {
          const guildId = normalizeDiscordGuildTarget(params.guildId);
          const name = readOptionalText(params.name);
          if (!guildId || !name) {
            return { ok: false, error: "Missing guildId or role name" };
          }

          const color = params.color as number | string | undefined;
          const hoist = readOptionalBoolean(params.hoist);
          const mentionable = readOptionalBoolean(params.mentionable);
          const position = readOptionalNumber(params.position);
          const reason = readOptionalText(params.reason);

          let permissions: string | string[] | number | undefined;
          const permissionsInput = params.permissions ?? params.permissionBits ?? params.permissionList;
          if (typeof permissionsInput === "number") {
            permissions = permissionsInput;
          } else if (Array.isArray(permissionsInput)) {
            permissions = permissionsInput
              .map((entry) => String(entry).trim())
              .filter(Boolean);
          } else if (typeof permissionsInput === "string") {
            permissions = permissionsInput.includes(",")
              ? permissionsInput.split(",").map((entry) => entry.trim()).filter(Boolean)
              : permissionsInput.trim();
          }

          const data = await client.createRole({
            guildId,
            name,
            color,
            hoist,
            mentionable,
            permissions,
            position,
            reason,
          });
          return { ok: true, data };
        }

        if (action === "editRole") {
          const guildId = normalizeDiscordGuildTarget(params.guildId);
          const roleId = normalizeDiscordRoleTarget(params.roleId);
          if (!guildId || !roleId) {
            return { ok: false, error: "Missing or invalid guildId/roleId" };
          }

          const name = readOptionalText(params.name);
          const color = params.color as number | string | undefined;
          const hoist = readOptionalBoolean(params.hoist);
          const mentionable = readOptionalBoolean(params.mentionable);
          const position = readOptionalNumber(params.position);
          const reason = readOptionalText(params.reason);

          let permissions: string | string[] | number | undefined;
          const permissionsInput = params.permissions ?? params.permissionBits ?? params.permissionList;
          if (typeof permissionsInput === "number") {
            permissions = permissionsInput;
          } else if (Array.isArray(permissionsInput)) {
            permissions = permissionsInput
              .map((entry) => String(entry).trim())
              .filter(Boolean);
          } else if (typeof permissionsInput === "string") {
            permissions = permissionsInput.includes(",")
              ? permissionsInput.split(",").map((entry) => entry.trim()).filter(Boolean)
              : permissionsInput.trim();
          }

          if (
            name === undefined &&
            color === undefined &&
            hoist === undefined &&
            mentionable === undefined &&
            permissions === undefined &&
            position === undefined
          ) {
            return { ok: false, error: "No editable role fields provided" };
          }

          const data = await client.editRole({
            guildId,
            roleId,
            name,
            color,
            hoist,
            mentionable,
            permissions,
            position,
            reason,
          });
          return { ok: true, data };
        }

        if (action === "deleteRole") {
          const guildId = normalizeDiscordGuildTarget(params.guildId);
          const roleId = normalizeDiscordRoleTarget(params.roleId);
          if (!guildId || !roleId) {
            return { ok: false, error: "Missing or invalid guildId/roleId" };
          }
          const reason = readOptionalText(params.reason);
          await client.deleteRole(guildId, roleId, reason);
          return { ok: true };
        }

        if (action === "addRoleToUser") {
          const guildId = normalizeDiscordGuildTarget(params.guildId);
          const userId = normalizeDiscordUserTarget(params.userId);
          const roleId = normalizeDiscordRoleTarget(params.roleId);
          if (!guildId || !userId || !roleId) {
            return { ok: false, error: "Missing or invalid guildId/userId/roleId" };
          }
          const reason = readOptionalText(params.reason);
          await client.addRoleToMember(guildId, userId, roleId, reason);
          return { ok: true };
        }

        if (action === "removeRoleFromUser") {
          const guildId = normalizeDiscordGuildTarget(params.guildId);
          const userId = normalizeDiscordUserTarget(params.userId);
          const roleId = normalizeDiscordRoleTarget(params.roleId);
          if (!guildId || !userId || !roleId) {
            return { ok: false, error: "Missing or invalid guildId/userId/roleId" };
          }
          const reason = readOptionalText(params.reason);
          await client.removeRoleFromMember(guildId, userId, roleId, reason);
          return { ok: true };
        }

        if (action === "setUserRoles") {
          const guildId = normalizeDiscordGuildTarget(params.guildId);
          const userId = normalizeDiscordUserTarget(params.userId);
          const clear = params.clear === true;
          const roleIds = clear ? [] : readRoleIdList(params.roleIds ?? params.roles);
          if (!guildId || !userId || (!clear && roleIds.length === 0)) {
            return { ok: false, error: "Missing or invalid guildId/userId/roleIds (or set clear=true)" };
          }
          const reason = readOptionalText(params.reason);
          await client.setMemberRoles(guildId, userId, roleIds, reason);
          return { ok: true };
        }

        if (action === "setNickname") {
          const guildId = normalizeDiscordGuildTarget(params.guildId);
          const userId = normalizeDiscordUserTarget(params.userId);
          if (!guildId || !userId) {
            return { ok: false, error: "Missing or invalid guildId/userId" };
          }

          let nickname: string | null | undefined = undefined;
          if (params.clear === true || params.nickname === null) {
            nickname = null;
          } else if (typeof params.nickname === "string") {
            const trimmed = params.nickname.trim();
            nickname = trimmed ? trimmed : null;
          }
          if (nickname === undefined) {
            return { ok: false, error: "Missing nickname (or set clear=true)" };
          }

          const reason = readOptionalText(params.reason);
          await client.setNickname(guildId, userId, nickname, reason);
          return { ok: true };
        }

        if (action === "kickUser") {
          const guildId = normalizeDiscordGuildTarget(params.guildId);
          const userId = normalizeDiscordUserTarget(params.userId);
          if (!guildId || !userId) {
            return { ok: false, error: "Missing or invalid guildId/userId" };
          }
          const reason = readOptionalText(params.reason);
          await client.kickUser(guildId, userId, reason);
          return { ok: true };
        }

        if (action === "banUser") {
          const guildId = normalizeDiscordGuildTarget(params.guildId);
          const userId = normalizeDiscordUserTarget(params.userId);
          if (!guildId || !userId) {
            return { ok: false, error: "Missing or invalid guildId/userId" };
          }

          const reason = readOptionalText(params.reason);
          const deleteMessageSeconds = readOptionalNumber(
            params.deleteMessageSeconds ?? params.deleteSeconds
          );
          await client.banUser({
            guildId,
            userId,
            reason,
            deleteMessageSeconds,
          });
          return { ok: true };
        }

        if (action === "unbanUser") {
          const guildId = normalizeDiscordGuildTarget(params.guildId);
          const userId = normalizeDiscordUserTarget(params.userId);
          if (!guildId || !userId) {
            return { ok: false, error: "Missing or invalid guildId/userId" };
          }
          const reason = readOptionalText(params.reason);
          await client.unbanUser(guildId, userId, reason);
          return { ok: true };
        }

        if (action === "timeoutUser") {
          const guildId = normalizeDiscordGuildTarget(params.guildId);
          const userId = normalizeDiscordUserTarget(params.userId);
          if (!guildId || !userId) {
            return { ok: false, error: "Missing or invalid guildId/userId" };
          }

          const durationMs = resolveTimeoutDurationMs(params);
          if (durationMs === undefined) {
            return { ok: false, error: "Missing timeout duration (minutes|durationMs|until|clear)" };
          }

          const reason = readOptionalText(params.reason);
          await client.timeoutUser({ guildId, userId, durationMs, reason });
          return { ok: true };
        }

        if (action === "listChannels") {
          const guildId = normalizeDiscordGuildTarget(params.guildId);
          if (!guildId) return { ok: false, error: "Missing or invalid guildId" };
          const data = await client.listGuildChannels(guildId);
          return { ok: true, data };
        }

        if (action === "createChannel") {
          const guildId = normalizeDiscordGuildTarget(params.guildId);
          const name = readOptionalText(params.name);
          if (!guildId || !name) {
            return { ok: false, error: "Missing guildId or channel name" };
          }

          const type = normalizeDiscordGuildChannelType(params.type ?? params.channelType);
          const parentRaw = params.parentId ?? params.parentChannelId;
          let parentId: string | null | undefined = undefined;
          if (parentRaw === null) {
            parentId = null;
          } else if (parentRaw !== undefined) {
            parentId = normalizeDiscordChannelTarget(parentRaw);
            if (!parentId) return { ok: false, error: "Invalid parentId" };
          }

          const topic =
            params.topic === null
              ? undefined
              : readOptionalText(params.topic);
          const nsfw = readOptionalBoolean(params.nsfw);
          const rateLimitPerUser = readOptionalNumber(params.rateLimitPerUser ?? params.slowmode);
          const bitrate = readOptionalNumber(params.bitrate);
          const userLimit = readOptionalNumber(params.userLimit);
          const rtcRegion =
            params.rtcRegion === null
              ? null
              : readOptionalText(params.rtcRegion);
          const reason = readOptionalText(params.reason);

          const data = await client.createGuildChannel({
            guildId,
            name,
            type,
            parentId,
            topic,
            nsfw,
            rateLimitPerUser,
            bitrate,
            userLimit,
            rtcRegion,
            reason,
          });
          return { ok: true, data };
        }

        if (action === "editChannel") {
          const channelId = normalizeDiscordChannelTarget(params.channelId || params.to);
          if (!channelId) return { ok: false, error: "Missing or invalid channelId" };

          const name = readOptionalText(params.name);
          const parentRaw = params.parentId ?? params.parentChannelId;
          let parentId: string | null | undefined = undefined;
          if (parentRaw === null) {
            parentId = null;
          } else if (parentRaw !== undefined) {
            parentId = normalizeDiscordChannelTarget(parentRaw);
            if (!parentId) return { ok: false, error: "Invalid parentId" };
          }

          let topic: string | null | undefined = undefined;
          if (params.topic === null) {
            topic = null;
          } else {
            topic = readOptionalText(params.topic);
          }

          const nsfw = readOptionalBoolean(params.nsfw);
          const rateLimitPerUser = readOptionalNumber(params.rateLimitPerUser ?? params.slowmode);
          const bitrate = readOptionalNumber(params.bitrate);
          const userLimit = readOptionalNumber(params.userLimit);
          const position = readOptionalNumber(params.position);
          const rtcRegion =
            params.rtcRegion === null
              ? null
              : readOptionalText(params.rtcRegion);
          const reason = readOptionalText(params.reason);

          const data = await client.editGuildChannel({
            channelId,
            name,
            parentId,
            topic,
            nsfw,
            rateLimitPerUser,
            bitrate,
            userLimit,
            rtcRegion,
            position,
            reason,
          });
          return { ok: true, data };
        }

        if (action === "deleteChannel") {
          const channelId = normalizeDiscordChannelTarget(params.channelId || params.to);
          if (!channelId) return { ok: false, error: "Missing or invalid channelId" };
          const reason = readOptionalText(params.reason);
          await client.deleteGuildChannel(channelId, reason);
          return { ok: true };
        }

        if (action === "voiceJoin") {
          const channelId = normalizeDiscordVoiceChannelTarget(params.channelId || params.to);
          if (!channelId) return { ok: false, error: "Missing or invalid channelId" };
          const selfMute = readOptionalBoolean(params.selfMute ?? params.mute);
          const selfDeaf = readOptionalBoolean(params.selfDeaf ?? params.deaf);
          const selfVideo = readOptionalBoolean(params.selfVideo ?? params.video);
          const data = await client.joinVoice(channelId, { selfMute, selfDeaf, selfVideo });
          return { ok: true, data };
        }

        if (action === "voiceLeave") {
          await client.leaveVoice();
          return { ok: true };
        }

        if (action === "voiceStatus") {
          const data = await client.getVoiceStatus();
          return { ok: true, data };
        }

        if (action === "setVoiceState") {
          const selfMute = readOptionalBoolean(params.selfMute ?? params.mute);
          const selfDeaf = readOptionalBoolean(params.selfDeaf ?? params.deaf);
          const selfVideo = readOptionalBoolean(params.selfVideo ?? params.video);
          if (selfMute === undefined && selfDeaf === undefined && selfVideo === undefined) {
            return { ok: false, error: "Missing voice state param (selfMute/selfDeaf/selfVideo)" };
          }
          await client.setVoiceState({ selfMute, selfDeaf, selfVideo });
          const data = await client.getVoiceStatus();
          return { ok: true, data };
        }
        if (action === "editMessage") {
          const channelId = params.channelId || params.to;
          const messageId = params.messageId;
          const content = params.content ?? params.text;
          if (!channelId || !messageId || typeof content !== "string") {
            return { ok: false, error: "Missing channelId, messageId, or content" };
          }
          await client.editMessage(channelId, messageId, content);
          return { ok: true };
        }

        if (action === "deleteMessage") {
          const channelId = params.channelId || params.to;
          const messageId = params.messageId;
          if (!channelId || !messageId) {
            return { ok: false, error: "Missing channelId or messageId" };
          }
          await client.deleteMessage(channelId, messageId);
          return { ok: true };
        }

        if (action === "typing") {
          const channelId = params.channelId || params.to;
          if (!channelId) return { ok: false, error: "Missing channelId" };
          await client.typing(channelId);
          return { ok: true };
        }

        if (action === "fetchMessages") {
          const channelId = params.channelId || params.to;
          const limit = Number(params.limit ?? params.count ?? account.config.historyLimit ?? 10);
          if (!channelId) return { ok: false, error: "Missing channelId" };
          const messages = await client.fetchMessages(channelId, Number.isFinite(limit) ? limit : 10);
          return { ok: true, data: messages };
        }

        if (action === "fetchMessage") {
          const channelId = params.channelId || params.to;
          const messageId = params.messageId;
          if (!channelId || !messageId) {
            return { ok: false, error: "Missing channelId or messageId" };
          }
          const message = await client.fetchMessage(channelId, messageId);
          return { ok: true, data: message };
        }

        if (action === "getChannelInfo") {
          const channelId = params.channelId || params.to;
          if (!channelId) return { ok: false, error: "Missing channelId" };
          const info = await client.getChannelInfo(channelId);
          return { ok: true, data: info };
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
            const resolvedAccount = resolveDiscordUserAccount({ cfg, accountId: account.accountId });

            const isDM = message.isDM;
            const wasMentioned = message.mentions?.some((m: any) => m.id === client?.user?.id) ?? false;

            const groupPolicy = resolveDiscordUserGroupPolicy(resolvedAccount, cfg);
            const requireMention = groupPolicy !== "open";
            const isGuildMessage = !isDM && Boolean(message.guildId);

            if (isGuildMessage) {
              const allowed = isDiscordUserGuildMessageAllowed({
                groupPolicy,
                guilds: resolvedAccount.config.guilds,
                guildId: message.guildId,
                channelId: message.channelId,
              });
              if (!allowed) {
                return;
              }
            }

            if (!isDM && requireMention && !wasMentioned) {
              return;
            }
            
            const peerKind = message.isDM ? "dm" : message.isThread ? "thread" : "channel";
            const peerId = message.isDM ? message.authorId : message.channelId;
            const agentId = resolveDefaultAgentId(cfg);
            
            const sessionKey = buildAgentPeerSessionKey({
              agentId,
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
