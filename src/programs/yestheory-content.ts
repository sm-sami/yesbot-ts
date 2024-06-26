import { Colors, EmbedBuilder, Message, TextChannel } from "discord.js";
import { ChatNames } from "../collections/chat-names.js";
import {
  Command,
  CommandHandler,
  DiscordEvent,
} from "../event-distribution/index.js";
import { GroupService } from "./group-manager/group-service.js";

@Command({
  event: DiscordEvent.MESSAGE,
  channelNames: ["yestheoryposted"],
  description:
    "This handler is for when yestheory uploads user in the specified group are pinged",
})
class YesTheoryUploadedPing implements CommandHandler<DiscordEvent.MESSAGE> {
  async handle(message: Message) {
    if (!message.webhookId) return;

    const channelDiscussion = message.guild?.channels.cache.find(
      (channel) => channel.name === ChatNames.YESTHEORY_DISCUSSION.toString()
    ) as TextChannel;
    const embed = new EmbedBuilder()
      .setColor(Colors.Blue)
      .setTitle("YesTheory Uploaded!")
      .setDescription(
        `Yes Theory posted a new video! Go check it out in ${message.channel.toString()} and talk about it here`
      );
    await channelDiscussion.send({ embeds: [embed] });

    const groupService = new GroupService();
    const group = await groupService.getGroupByName("YesTheoryUploads");
    if (group) await groupService.pingGroup(group, channelDiscussion);
  }
}
