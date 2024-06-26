import { VoiceState } from "discord.js";
import {
  Command,
  CommandHandler,
  DiscordEvent,
} from "../../../event-distribution/index.js";
import { VoiceStateChange } from "../../../event-distribution/events/voice-state-update.js";
import { VoiceOnDemandService } from "../voice-on-demand-service.js";

@Command({
  event: DiscordEvent.VOICE_STATE_UPDATE,
  changes: [VoiceStateChange.JOINED, VoiceStateChange.SWITCHED_CHANNEL],
})
class VoiceAcceptAllUsers extends CommandHandler<DiscordEvent.VOICE_STATE_UPDATE> {
  private readonly vodService = new VoiceOnDemandService();

  async handle(before: VoiceState, after: VoiceState): Promise<void> {
    const newChannel = after.channel!;

    // We are only concerned about the first join
    if (newChannel.members.size > 1) return;

    const userId = after.id;

    const mapping = await this.vodService.mappingByUserId(userId);
    if (!mapping || mapping.channelId !== after.channelId) return;

    const everyone = newChannel.guild.roles.everyone;
    await newChannel.permissionOverwrites.edit(everyone, {
      Stream: true,
      UseEmbeddedActivities: true,
      Connect: null,
    });

    await newChannel.permissionOverwrites.delete(userId);
  }
}
