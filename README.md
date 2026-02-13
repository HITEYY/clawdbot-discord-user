# @alex110709/discord-user

Clawdbot plugin for Discord **user account** (selfbot) integration. This allows Clawdbot to act as a real Discord user, not a bot.

> ⚠️ **Warning**: Using selfbots violates Discord's Terms of Service. Your account may be banned. Use at your own risk. This plugin is intended for personal automation and testing purposes only.

## Features

- Login as a real Discord user account
- Send and receive messages in DMs, channels, and threads
- React to messages
- Send media attachments
- Typing indicators
- Message history fetching
- Voice call controls (ring/join/leave/mute/deafen/status)
- Server administration actions (roles/moderation/channel management)

## Installation

### From npm (when published)

```bash
clawdbot plugins install @alex110709/discord-user
```

### From local directory

```bash
# Build the plugin
cd discord-user-plugin
npm install
npm run build

# Install to Clawdbot
clawdbot plugins install -l ./discord-user-plugin
```

## Configuration

### Getting your Discord User Token

1. Open Discord in your browser (not the desktop app)
2. Press F12 to open Developer Tools
3. Go to the Network tab
4. Send a message in any channel
5. Look for a request to `messages` and click it
6. In the Headers tab, find the `Authorization` header - this is your token

Or use browser console:
```javascript
// In Discord web app console
(webpackChunkdiscord_app.push([[''],{},e=>{m=[];for(let c in e.c)m.push(e.c[c])}]),m).find(m=>m?.exports?.default?.getToken!==void 0).exports.default.getToken()
```

### Config file

Add to your Clawdbot config (`~/.clawdbot/config.json5`):

```json5
{
  channels: {
    "discord-user": {
      enabled: true,
      token: "YOUR_DISCORD_USER_TOKEN",
      // Or use environment variable: DISCORD_USER_TOKEN
      
      // DM policy: "open" | "pairing" | "allowlist"
      dmPolicy: "pairing",
      
      // Allowed user IDs for DMs
      allowFrom: ["123456789012345678"],
      
      // Group/channel policy: "open" | "allowlist"
      groupPolicy: "allowlist",
      
      // Guild/channel allowlist
      guilds: {
        "GUILD_ID": {
          enabled: true,
          channels: {
            "CHANNEL_ID": true
          }
        }
      }
    }
  }
}
```

#### Group policy behavior

- `groupPolicy: "allowlist"`: only guild/channels configured under `guilds` can trigger.
- `groupPolicy: "open"`: all guild channels can trigger by default.
- You can explicitly block in `open` mode using `enabled: false` on a guild or channel entry.

Example deny rule:

```json5
{
  channels: {
    "discord-user": {
      groupPolicy: "open",
      guilds: {
        "GUILD_ID": {
          enabled: true,
          channels: {
            "CHANNEL_ID": false // explicitly blocked
          }
        }
      }
    }
  }
}
```

### Environment variable

```bash
export DISCORD_USER_TOKEN="your_token_here"
```

### Multi-account setup

```json5
{
  channels: {
    "discord-user": {
      enabled: true,
      accounts: {
        main: {
          token: "TOKEN_1",
          name: "Main Account"
        },
        alt: {
          token: "TOKEN_2",
          name: "Alt Account"
        }
      }
    }
  }
}
```

## Usage

Once configured and the gateway is running, Clawdbot will:

1. Log in as the Discord user
2. Listen for messages in allowed channels/DMs
3. Respond as configured by your Clawdbot setup

### Sending messages

The plugin integrates with Clawdbot's messaging system. You can send messages using:

```bash
# CLI
clawdbot send --channel discord-user --to "channel:CHANNEL_ID" "Hello!"
clawdbot send --channel discord-user --to "user:USER_ID" "Hello!"

# Or via message tool in agent
message action=send channel=discord-user to="channel:123456789" message="Hello!"
```

### Target formats

- `channel:CHANNEL_ID` - Send to a text channel
- `user:USER_ID` - Send to a user's DM
- `CHANNEL_ID` - Raw channel ID (sends to channel)


### Extended actions

The plugin also exposes action endpoints for advanced channel control:

- `react` / `deleteMessage` / `editMessage`
- `typing`
- `fetchMessages` / `fetchMessage`
- `getChannelInfo`
- `setStatus`
- `addFriend` / `removeFriend`
- `listGuilds` / `leaveGuild` / `joinGuild`
<<<<<<< ours
- Roles: `listRoles` / `createRole` / `editRole` / `deleteRole` / `addRoleToUser` / `removeRoleFromUser` / `setUserRoles`
- Moderation: `setNickname` / `kickUser` / `banUser` / `unbanUser` / `timeoutUser`
- Channels: `listChannels` / `createChannel` / `editChannel` / `deleteChannel`
- `callUser` / `voiceJoin` / `voiceLeave` / `voiceStatus` / `setVoiceState`

Voice call examples:

```bash
# Ring a user in DM
message action=callUser channel=discord-user userId="123456789012345678"

# Join a guild voice channel
message action=voiceJoin channel=discord-user channelId="123456789012345678"

# Mute/deafen self in the current voice session
message action=setVoiceState channel=discord-user selfMute=true selfDeaf=true

# Check current voice state
message action=voiceStatus channel=discord-user

# Leave current voice session
message action=voiceLeave channel=discord-user
```

Server management examples:

```bash
# Add a role to a user
message action=addRoleToUser channel=discord-user guildId="GUILD_ID" userId="USER_ID" roleId="ROLE_ID"

# Kick a user
message action=kickUser channel=discord-user guildId="GUILD_ID" userId="USER_ID" reason="rule violation"

# Timeout user for 30 minutes
message action=timeoutUser channel=discord-user guildId="GUILD_ID" userId="USER_ID" minutes=30

# Create a text channel
message action=createChannel channel=discord-user guildId="GUILD_ID" name="ops-log" type="text"

# Edit slowmode on a channel
message action=editChannel channel=discord-user channelId="CHANNEL_ID" slowmode=10
```
=======
>>>>>>> theirs

## Security Considerations

1. **Token Security**: Your Discord token is equivalent to your password. Keep it secret.
2. **ToS Violation**: Selfbots violate Discord ToS. Your account may be banned without warning.
3. **Rate Limits**: Discord has strict rate limits. Excessive automation can trigger them.
4. **Account Safety**: Use a secondary account if possible.

## Differences from Bot Account

| Feature | Bot Account | User Account (Selfbot) |
|---------|------------|----------------------|
| ToS Compliant | ✅ Yes | ❌ No |
| Nitro Features | ❌ No | ✅ Yes (if subscribed) |
| Join Servers | Invite link | Normal join |
| DM Anyone | ❌ Restricted | ✅ Yes |
| Read Messages | Only with intent | ✅ All visible |
| Slash Commands | ✅ Yes | ❌ No (can't create) |
| Polls | ✅ Yes | ❌ No (can't create) |

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Watch mode
npm run watch
```

## Troubleshooting

### "Invalid token"
- Make sure you're using a user token, not a bot token
- User tokens don't start with "Bot " prefix
- Token may have expired - get a new one

### "Rate limited"
- Reduce message frequency
- Add delays between operations
- Discord rate limits are stricter for user accounts

### "Cannot access channel"
- User must have permission to view the channel
- Check if user is in the guild
- Verify channel ID is correct

## License

MIT
