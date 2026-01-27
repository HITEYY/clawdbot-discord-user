import type { ClawdbotPluginApi } from "clawdbot/plugin-sdk";
import { emptyPluginConfigSchema } from "clawdbot/plugin-sdk";

import { discordUserPlugin } from "./channel.js";
import { setDiscordUserRuntime } from "./runtime.js";

const plugin = {
  id: "discord-user",
  name: "Discord User",
  description: "Discord user account (selfbot) channel plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: ClawdbotPluginApi) {
    setDiscordUserRuntime(api.runtime);
    api.registerChannel({ plugin: discordUserPlugin });
  },
};

export default plugin;
