import type { MoltbotPluginApi } from "clawdbot/plugin-sdk";
import { emptyPluginConfigSchema } from "clawdbot/plugin-sdk";
import { discordUserPlugin } from "./channel.js";

const plugin = {
  id: "discord-user",
  name: "Discord User",
  description: "Discord user account (selfbot) channel plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: MoltbotPluginApi) {
    api.registerChannel({ plugin: discordUserPlugin });
  },
};

export default plugin;
