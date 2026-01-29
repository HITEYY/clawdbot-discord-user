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

