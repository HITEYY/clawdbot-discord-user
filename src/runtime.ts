// Runtime injection for Discord User plugin
let discordUserRuntime: any = null;

export function setDiscordUserRuntime(runtime: any): void {
  discordUserRuntime = runtime;
}

export function getDiscordUserRuntime(): any {
  if (!discordUserRuntime) {
    throw new Error("Discord User runtime not initialized");
  }
  return discordUserRuntime;
}
