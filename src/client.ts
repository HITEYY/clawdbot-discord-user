import { Client, Message, TextChannel, DMChannel, ThreadChannel, NewsChannel, Invite } from "discord.js-selfbot-v13";

export interface DiscordUserAccount {
  accountId: string;
  token: string;
  config: any;
}

export interface InboundMessage {
  id: string;
  channelId: string;
  guildId?: string;
  authorId: string;
  authorName: string;
  authorTag: string;
  content: string;
  timestamp: string;
  replyToId?: string;
  attachments: Array<{
    id: string;
    url: string;
    filename: string;
    contentType?: string;
    size: number;
  }>;
  mentions: Array<{ id: string; username: string }>;
  isBot: boolean;
  isDM: boolean;
  isThread: boolean;
  threadName?: string;
  guildName?: string;
  channelName?: string;
}

export interface DiscordUserClientOptions {
  token: string;
  accountId: string;
  config: any;
  runtime: any;
  onMessage: (message: InboundMessage) => Promise<void>;
  onReady: (user: { id: string; tag: string; username: string }) => void;
  onError: (error: Error | string) => void;
  onDisconnect: () => void;
}

export class DiscordUserClient {
  private client: Client;
  private options: DiscordUserClientOptions;
  private _isRunning = false;
  private _user: { id: string; tag: string; username: string } | null = null;

  constructor(options: DiscordUserClientOptions) {
    this.options = options;
    // @ts-ignore - discord.js-selfbot-v13 has different options
    this.client = new Client({
      checkUpdate: false,
      ws: {
        properties: {
          browser: "Discord Client",
          os: "Windows",
          device: "",
        },
      },
    } as any);

    this.setupEventHandlers();
  }

  get isRunning(): boolean {
    return this._isRunning;
  }

  get user(): { id: string; tag: string; username: string } | null {
    return this._user;
  }

  private async fetchGuildOrThrow(guildId: string): Promise<any> {
    const guild = await this.client.guilds.fetch(guildId);
    if (!guild) {
      throw new Error(`Guild ${guildId} not found`);
    }
    return guild;
  }

  private summarizeGuildChannel(channel: any): {
    id: string;
    guildId?: string;
    name?: string;
    type: string;
    parentId?: string | null;
    position?: number;
    topic?: string | null;
    nsfw?: boolean;
    rateLimitPerUser?: number | null;
    bitrate?: number;
    userLimit?: number;
    rtcRegion?: string | null;
  } {
    return {
      id: String(channel.id),
      guildId: channel.guild?.id,
      name: channel.name,
      type: String(channel.type),
      parentId: channel.parentId ?? null,
      position: typeof channel.position === "number" ? channel.position : undefined,
      topic: channel.topic ?? null,
      nsfw: typeof channel.nsfw === "boolean" ? channel.nsfw : undefined,
      rateLimitPerUser:
        typeof channel.rateLimitPerUser === "number" ? channel.rateLimitPerUser : undefined,
      bitrate: typeof channel.bitrate === "number" ? channel.bitrate : undefined,
      userLimit: typeof channel.userLimit === "number" ? channel.userLimit : undefined,
      rtcRegion: typeof channel.rtcRegion === "string" || channel.rtcRegion === null ? channel.rtcRegion : undefined,
    };
  }

  private setupEventHandlers(): void {
    this.client.on("ready", () => {
      if (this.client.user) {
        this._user = {
          id: this.client.user.id,
          tag: this.client.user.tag,
          username: this.client.user.username,
        };
        this._isRunning = true;
        this.options.onReady(this._user);
      }
    });

    this.client.on("messageCreate", async (message: Message) => {
      // Skip messages from self unless configured otherwise
      if (message.author.id === this.client.user?.id) {
        return;
      }

      try {
        const inbound = this.transformMessage(message);
        await this.options.onMessage(inbound);
      } catch (err) {
        this.options.onError(err instanceof Error ? err : new Error(String(err)));
      }
    });

    this.client.on("error", (error: Error) => {
      this.options.onError(error);
    });

    this.client.on("disconnect", () => {
      this._isRunning = false;
      this.options.onDisconnect();
    });

    this.client.on("warn", (info: string) => {
      console.warn(`[discord-user] Warning: ${info}`);
    });
  }

  private transformMessage(message: Message): InboundMessage {
    const isDM = message.channel.type === "DM";
    const isThread = message.channel.isThread?.() ?? false;

    let guildName: string | undefined;
    let channelName: string | undefined;
    let threadName: string | undefined;

    if (!isDM) {
      const channel = message.channel as TextChannel | NewsChannel | ThreadChannel;
      guildName = message.guild?.name;
      channelName = channel.name;
      if (isThread && channel instanceof ThreadChannel) {
        threadName = channel.name;
      }
    }

    return {
      id: message.id,
      channelId: message.channel.id,
      guildId: message.guild?.id,
      authorId: message.author.id,
      authorName: message.author.username,
      authorTag: message.author.tag,
      content: message.content,
      timestamp: message.createdAt.toISOString(),
      replyToId: message.reference?.messageId ?? undefined,
      attachments: message.attachments.map((att) => ({
        id: att.id,
        url: att.url,
        filename: att.name ?? "unknown",
        contentType: att.contentType ?? undefined,
        size: att.size,
      })),
      mentions: message.mentions.users.map((u) => ({ id: u.id, username: u.username })),
      isBot: message.author.bot,
      isDM,
      isThread,
      threadName,
      guildName,
      channelName,
    };
  }

  async start(): Promise<void> {
    try {
      await this.client.login(this.options.token);
    } catch (err) {
      this._isRunning = false;
      throw err;
    }
  }

  async stop(): Promise<void> {
    this._isRunning = false;
    try {
      this.client.destroy();
    } catch {
      // Ignore errors during shutdown
    }
  }

  async sendMessage(
    target: string,
    content: string,
    options?: { replyTo?: string; mediaUrl?: string }
  ): Promise<{ id: string }> {
    let channelId = target;
    let isUser = false;

    if (target.startsWith("user:")) {
      channelId = target.slice(5);
      isUser = true;
    } else if (target.startsWith("channel:")) {
      channelId = target.slice(8);
    }

    let channel: TextChannel | DMChannel | ThreadChannel | NewsChannel;

    if (isUser) {
      const user = await this.client.users.fetch(channelId);
      channel = await user.createDM();
    } else {
      const fetched = await this.client.channels.fetch(channelId);
      if (!fetched || !("send" in fetched)) {
        throw new Error(`Channel ${channelId} not found or not a text channel`);
      }
      channel = fetched as TextChannel | DMChannel | ThreadChannel | NewsChannel;
    }

    const messageOptions: any = {};

    if (options?.replyTo) {
      messageOptions.reply = {
        messageReference: options.replyTo,
        failIfNotExists: false,
      };
    }

    if (options?.mediaUrl) {
      messageOptions.files = [options.mediaUrl];
    }

    const sent = await channel.send({
      content: content || undefined,
      ...messageOptions,
    });

    return { id: sent.id };
  }

  async react(
    channelId: string,
    messageId: string,
    emoji?: string,
    remove?: boolean
  ): Promise<void> {
    const channel = await this.client.channels.fetch(channelId);
    if (!channel || !("messages" in channel)) {
      throw new Error(`Channel ${channelId} not found`);
    }

    const textChannel = channel as TextChannel | DMChannel | ThreadChannel | NewsChannel;
    const message = await textChannel.messages.fetch(messageId);

    if (remove) {
      const reaction = message.reactions.cache.find((r) => {
        if (!emoji) return true;
        return r.emoji.name === emoji || r.emoji.toString() === emoji;
      });
      if (reaction) {
        await reaction.users.remove(this.client.user!.id);
      }
    } else if (emoji) {
      await message.react(emoji);
    }
  }

  async editMessage(
    channelId: string,
    messageId: string,
    content: string
  ): Promise<void> {
    const channel = await this.client.channels.fetch(channelId);
    if (!channel || !("messages" in channel)) {
      throw new Error(`Channel ${channelId} not found`);
    }

    const textChannel = channel as TextChannel | DMChannel | ThreadChannel | NewsChannel;
    const message = await textChannel.messages.fetch(messageId);

    if (message.author.id !== this.client.user?.id) {
      throw new Error("Can only edit own messages");
    }

    await message.edit(content);
  }

  async deleteMessage(channelId: string, messageId: string): Promise<void> {
    const channel = await this.client.channels.fetch(channelId);
    if (!channel || !("messages" in channel)) {
      throw new Error(`Channel ${channelId} not found`);
    }

    const textChannel = channel as TextChannel | DMChannel | ThreadChannel | NewsChannel;
    const message = await textChannel.messages.fetch(messageId);
    await message.delete();
  }

  async typing(channelId: string): Promise<void> {
    const channel = await this.client.channels.fetch(channelId);
    if (!channel || !("sendTyping" in channel)) {
      return;
    }
    const textChannel = channel as TextChannel | DMChannel | ThreadChannel | NewsChannel;
    await textChannel.sendTyping();
  }

  async setStatus(status: string, type: "PLAYING" | "WATCHING" | "LISTENING" | "COMPETING" | "STREAMING" = "PLAYING"): Promise<void> {
    if (!this.client.user) throw new Error("Client not logged in");
    this.client.user.setActivity(status, { type: type as any });
  }

  async callUser(userId: string): Promise<{ channelId: string }> {
    const user = await this.client.users.fetch(userId);
    const dm = await user.createDM();
    if (typeof (dm as any).ring !== "function") {
      throw new Error("DM voice calling is not supported in this client version");
    }
    await (dm as any).ring();
    return { channelId: dm.id };
  }

  async joinVoice(
    channelId: string,
    options?: { selfMute?: boolean; selfDeaf?: boolean; selfVideo?: boolean }
  ): Promise<{ channelId: string; guildId?: string; status: string }> {
    const channel = await this.client.channels.fetch(channelId);
    if (!channel) {
      throw new Error(`Channel ${channelId} not found`);
    }

    const channelType = String((channel as any).type);
    const voiceCapableTypes = new Set(["GUILD_VOICE", "GUILD_STAGE_VOICE", "DM", "GROUP_DM"]);
    if (!voiceCapableTypes.has(channelType)) {
      throw new Error(`Channel ${channelId} is not a voice-capable channel`);
    }

    const connection = await this.client.voice.joinChannel(channel as any, {
      selfMute: options?.selfMute,
      selfDeaf: options?.selfDeaf,
      selfVideo: options?.selfVideo,
    });

    return {
      channelId: connection.channel.id,
      guildId: (connection.channel as any).guild?.id,
      status: String(connection.status),
    };
  }

  async leaveVoice(): Promise<void> {
    const connection = this.client.voice.connection;
    if (!connection) return;
    connection.disconnect();
  }

  async setVoiceState(params: {
    selfMute?: boolean;
    selfDeaf?: boolean;
    selfVideo?: boolean;
  }): Promise<void> {
    const connection = this.client.voice.connection;
    if (!connection) {
      throw new Error("Not connected to a voice channel");
    }

    const voice = this.client.user?.voice;
    await connection.sendVoiceStateUpdate({
      self_mute: params.selfMute ?? voice?.selfMute ?? false,
      self_deaf: params.selfDeaf ?? voice?.selfDeaf ?? false,
      self_video: params.selfVideo ?? voice?.selfVideo ?? false,
    });
  }

  async getVoiceStatus(): Promise<{
    connected: boolean;
    channelId?: string;
    guildId?: string;
    channelType?: string;
    status?: string;
    selfMute?: boolean | null;
    selfDeaf?: boolean | null;
    selfVideo?: boolean | null;
  }> {
    const connection = this.client.voice.connection;
    const voice = this.client.user?.voice;
    const connected = Boolean(connection);

    return {
      connected,
      channelId: connection?.channel?.id ?? voice?.channelId ?? undefined,
      guildId: (connection?.channel as any)?.guild?.id,
      channelType: connection ? String((connection.channel as any).type) : undefined,
      status: connection ? String(connection.status) : undefined,
      selfMute: voice?.selfMute ?? null,
      selfDeaf: voice?.selfDeaf ?? null,
      selfVideo: voice?.selfVideo ?? null,
    };
  }

  async acceptFriendRequest(userId: string): Promise<void> {
    // @ts-ignore
    if (this.client.relationships) {
       // @ts-ignore
       await this.client.relationships.addFriend(userId);
    } else {
        const user = await this.client.users.fetch(userId);
        // @ts-ignore
        await user.sendFriendRequest();
    }
  }

  async removeFriend(userId: string): Promise<void> {
     // @ts-ignore
     if (this.client.relationships) {
       // @ts-ignore
       await this.client.relationships.deleteFriend(userId);
     } else {
        const user = await this.client.users.fetch(userId);
        // @ts-ignore
        await user.removeFriend();
     }
  }
  
  async getGuilds(): Promise<Array<{ id: string; name: string; memberCount: number }>> {
      return this.client.guilds.cache.map(g => ({
          id: g.id,
          name: g.name,
          memberCount: g.memberCount
      }));
  }

  async listRoles(guildId: string): Promise<Array<{
    id: string;
    name: string;
    color: number;
    hexColor: string;
    position: number;
    mentionable: boolean;
    hoist: boolean;
    managed: boolean;
    permissions: string;
  }>> {
    const guild = await this.fetchGuildOrThrow(guildId);
    await guild.roles.fetch();
    return guild.roles.cache
      .sort((a: any, b: any) => b.position - a.position)
      .map((role: any) => ({
        id: role.id,
        name: role.name,
        color: role.color,
        hexColor: role.hexColor,
        position: role.position,
        mentionable: role.mentionable,
        hoist: role.hoist,
        managed: role.managed,
        permissions: role.permissions?.bitfield?.toString?.() ?? "",
      }));
  }

  async createRole(params: {
    guildId: string;
    name: string;
    color?: number | string;
    hoist?: boolean;
    mentionable?: boolean;
    permissions?: string | string[] | number;
    position?: number;
    reason?: string;
  }): Promise<{ id: string; name: string }> {
    const guild = await this.fetchGuildOrThrow(params.guildId);
    const role = await guild.roles.create({
      name: params.name,
      color: params.color,
      hoist: params.hoist,
      mentionable: params.mentionable,
      permissions: params.permissions as any,
      position: params.position,
      reason: params.reason,
    });
    return { id: role.id, name: role.name };
  }

  async editRole(params: {
    guildId: string;
    roleId: string;
    name?: string;
    color?: number | string;
    hoist?: boolean;
    mentionable?: boolean;
    permissions?: string | string[] | number;
    position?: number;
    reason?: string;
  }): Promise<{ id: string; name: string }> {
    const guild = await this.fetchGuildOrThrow(params.guildId);
    const role = await guild.roles.edit(
      params.roleId,
      {
        name: params.name,
        color: params.color,
        hoist: params.hoist,
        mentionable: params.mentionable,
        permissions: params.permissions as any,
        position: params.position,
      },
      params.reason
    );
    return { id: role.id, name: role.name };
  }

  async deleteRole(guildId: string, roleId: string, reason?: string): Promise<void> {
    const guild = await this.fetchGuildOrThrow(guildId);
    await guild.roles.delete(roleId, reason);
  }

  async addRoleToMember(
    guildId: string,
    userId: string,
    roleId: string,
    reason?: string
  ): Promise<void> {
    const guild = await this.fetchGuildOrThrow(guildId);
    const member = await guild.members.fetch(userId);
    await member.roles.add(roleId, reason);
  }

  async removeRoleFromMember(
    guildId: string,
    userId: string,
    roleId: string,
    reason?: string
  ): Promise<void> {
    const guild = await this.fetchGuildOrThrow(guildId);
    const member = await guild.members.fetch(userId);
    await member.roles.remove(roleId, reason);
  }

  async setMemberRoles(
    guildId: string,
    userId: string,
    roleIds: string[],
    reason?: string
  ): Promise<void> {
    const guild = await this.fetchGuildOrThrow(guildId);
    const member = await guild.members.fetch(userId);
    await member.roles.set(roleIds, reason);
  }

  async setNickname(
    guildId: string,
    userId: string,
    nickname: string | null,
    reason?: string
  ): Promise<void> {
    const guild = await this.fetchGuildOrThrow(guildId);
    const member = await guild.members.fetch(userId);
    await member.setNickname(nickname, reason);
  }

  async kickUser(guildId: string, userId: string, reason?: string): Promise<void> {
    const guild = await this.fetchGuildOrThrow(guildId);
    await guild.members.kick(userId, reason);
  }

  async banUser(params: {
    guildId: string;
    userId: string;
    reason?: string;
    deleteMessageSeconds?: number;
  }): Promise<void> {
    const guild = await this.fetchGuildOrThrow(params.guildId);
    await guild.members.ban(params.userId, {
      reason: params.reason,
      deleteMessageSeconds: params.deleteMessageSeconds,
    });
  }

  async unbanUser(guildId: string, userId: string, reason?: string): Promise<void> {
    const guild = await this.fetchGuildOrThrow(guildId);
    await guild.members.unban(userId, reason);
  }

  async timeoutUser(params: {
    guildId: string;
    userId: string;
    durationMs: number | null;
    reason?: string;
  }): Promise<void> {
    const guild = await this.fetchGuildOrThrow(params.guildId);
    const member = await guild.members.fetch(params.userId);
    await member.timeout(params.durationMs, params.reason);
  }

  async listGuildChannels(guildId: string): Promise<Array<{
    id: string;
    guildId?: string;
    name?: string;
    type: string;
    parentId?: string | null;
    position?: number;
    topic?: string | null;
    nsfw?: boolean;
    rateLimitPerUser?: number | null;
    bitrate?: number;
    userLimit?: number;
    rtcRegion?: string | null;
  }>> {
    const guild = await this.fetchGuildOrThrow(guildId);
    await guild.channels.fetch();
    return guild.channels.cache
      .filter((channel: any) => Boolean(channel))
      .sort((a: any, b: any) => (a.position ?? 0) - (b.position ?? 0))
      .map((channel: any) => this.summarizeGuildChannel(channel));
  }

  async createGuildChannel(params: {
    guildId: string;
    name: string;
    type?: string;
    parentId?: string | null;
    topic?: string;
    nsfw?: boolean;
    rateLimitPerUser?: number;
    bitrate?: number;
    userLimit?: number;
    rtcRegion?: string | null;
    reason?: string;
  }): Promise<{
    id: string;
    guildId?: string;
    name?: string;
    type: string;
    parentId?: string | null;
    position?: number;
    topic?: string | null;
    nsfw?: boolean;
    rateLimitPerUser?: number | null;
    bitrate?: number;
    userLimit?: number;
    rtcRegion?: string | null;
  }> {
    const guild = await this.fetchGuildOrThrow(params.guildId);
    const created = await guild.channels.create(params.name, {
      type: params.type as any,
      parent: params.parentId ?? undefined,
      topic: params.topic,
      nsfw: params.nsfw,
      rateLimitPerUser: params.rateLimitPerUser,
      bitrate: params.bitrate,
      userLimit: params.userLimit,
      rtcRegion: params.rtcRegion ?? undefined,
      reason: params.reason,
    });
    return this.summarizeGuildChannel(created);
  }

  async editGuildChannel(params: {
    channelId: string;
    name?: string;
    parentId?: string | null;
    topic?: string | null;
    nsfw?: boolean;
    rateLimitPerUser?: number;
    bitrate?: number;
    userLimit?: number;
    rtcRegion?: string | null;
    position?: number;
    reason?: string;
  }): Promise<{
    id: string;
    guildId?: string;
    name?: string;
    type: string;
    parentId?: string | null;
    position?: number;
    topic?: string | null;
    nsfw?: boolean;
    rateLimitPerUser?: number | null;
    bitrate?: number;
    userLimit?: number;
    rtcRegion?: string | null;
  }> {
    const fetched = await this.client.channels.fetch(params.channelId);
    if (!fetched || !("guild" in (fetched as any))) {
      throw new Error(`Guild channel ${params.channelId} not found`);
    }
    const channel = fetched as any;
    const guild = channel.guild;
    if (!guild) {
      throw new Error(`Guild channel ${params.channelId} not found`);
    }

    const patch: any = {};
    if (typeof params.name === "string") patch.name = params.name;
    if (typeof params.parentId === "string" || params.parentId === null) patch.parent = params.parentId;
    if (typeof params.topic === "string" || params.topic === null) patch.topic = params.topic;
    if (typeof params.nsfw === "boolean") patch.nsfw = params.nsfw;
    if (typeof params.rateLimitPerUser === "number") patch.rateLimitPerUser = params.rateLimitPerUser;
    if (typeof params.bitrate === "number") patch.bitrate = params.bitrate;
    if (typeof params.userLimit === "number") patch.userLimit = params.userLimit;
    if (typeof params.rtcRegion === "string" || params.rtcRegion === null) patch.rtcRegion = params.rtcRegion;
    if (typeof params.position === "number") patch.position = params.position;

    if (Object.keys(patch).length === 0) {
      throw new Error("No editable channel fields provided");
    }

    const edited = await guild.channels.edit(params.channelId, patch, params.reason);
    return this.summarizeGuildChannel(edited);
  }

  async deleteGuildChannel(channelId: string, reason?: string): Promise<void> {
    const channel = await this.client.channels.fetch(channelId);
    if (!channel || typeof (channel as any).delete !== "function") {
      throw new Error(`Channel ${channelId} not found`);
    }
    await (channel as any).delete(reason);
  }

  async leaveGuild(guildId: string): Promise<void> {
      const guild = await this.client.guilds.fetch(guildId);
      await guild.leave();
  }

  async joinGuild(inviteCode: string): Promise<void> {
    // @ts-ignore - acceptInvite is a selfbot-specific method
    await this.client.acceptInvite(inviteCode);
  }

  async fetchMessages(
    channelId: string,
    limit = 10
  ): Promise<InboundMessage[]> {
    const channel = await this.client.channels.fetch(channelId);
    if (!channel || !("messages" in channel)) {
      throw new Error(`Channel ${channelId} not found`);
    }

    const textChannel = channel as TextChannel | DMChannel | ThreadChannel | NewsChannel;
    const messages = await textChannel.messages.fetch({ limit });

    return messages.map((m) => this.transformMessage(m)).reverse();
  }

  async getChannelInfo(channelId: string): Promise<{
    id: string;
    type: string;
    name?: string;
    guildId?: string;
    guildName?: string;
  }> {
    const channel = await this.client.channels.fetch(channelId);
    if (!channel) {
      throw new Error(`Channel ${channelId} not found`);
    }

    const maybeGuildChannel = channel as any;

    return {
      id: channel.id,
      type: String(channel.type),
      name: (channel as any).name,
      guildId: maybeGuildChannel.guild?.id,
      guildName: maybeGuildChannel.guild?.name,
    };
  }

  async fetchMessage(channelId: string, messageId: string): Promise<InboundMessage> {
    const channel = await this.client.channels.fetch(channelId);
    if (!channel || !("messages" in channel)) {
      throw new Error(`Channel ${channelId} not found`);
    }

    const textChannel = channel as TextChannel | DMChannel | ThreadChannel | NewsChannel;
    const message = await textChannel.messages.fetch(messageId);
    return this.transformMessage(message);
  }

  async probe(token: string): Promise<any> {
      // Create a temporary client to probe
      const tempClient = new Client({ checkUpdate: false } as any);
      try {
          await tempClient.login(token);
          const user = tempClient.user;
          const result = {
              ok: true,
              user: user ? {
                  id: user.id,
                  username: user.username,
                  tag: user.tag
              } : null
          };
          tempClient.destroy();
          return result;
      } catch (err) {
          tempClient.destroy();
          return { ok: false, error: String(err) };
      }
  }
}
