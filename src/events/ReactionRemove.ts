import Discord, {
  Snowflake,
  User,
  Channel,
  Guild,
  TextChannel,
  PartialUser,
} from "discord.js";
import bot from "../index";
import Tools from "../common/tools";
import { ChannelToggleRepository } from "../entities/ChannelToggle";
import { textLog } from "../common/moderator";
import { ReactionRoleRepository } from "../entities/ReactionRole";

class ReactionRemove {
  bot: Discord.Client;
  messageId: Snowflake;
  user: User;
  reaction: string;
  channel: TextChannel;
  guild: Guild;

  constructor(
    messageReaction: Discord.MessageReaction,
    user: User | PartialUser
  ) {
    this.bot = bot;
    this.user = <User>user;
    this.messageId = messageReaction.message.id;
    this.reaction = messageReaction.emoji.name;
    this.channel = <TextChannel>messageReaction.message.channel;
    this.guild = <Guild>this.channel.guild;
    if (this.channel.name != "pick-your-color") this.main();
  }

  async main() {
    const reactionRoleRepository = await ReactionRoleRepository();
    const reactRoleObjects = await reactionRoleRepository.find();
    reactRoleObjects.forEach((reactionRole) => {
      if (
        this.messageId === reactionRole.messageId &&
        this.reaction === reactionRole.reaction
      ) {
        const guildMember = this.guild.members.cache.find(
          (m) => m.id == this.user.id
        );
        const roleToAdd = this.guild.roles.cache.find(
          (r) => r.id == reactionRole.roleId
        );
        guildMember.roles.remove(roleToAdd);
      }
    });

    this.handleChannelToggleReaction();
  }

  async handleChannelToggleReaction() {
    const channelToggleRepository = await ChannelToggleRepository();
    const toggle = await channelToggleRepository.findOne({
      where: {
        emoji: this.reaction,
        message: this.messageId,
      },
    });
    if (toggle === undefined) {
      return;
    }

    const channel = this.guild.channels.cache.find(
      (c) => c.id === toggle.channel
    );

    if (channel === undefined) {
      textLog(
        `I can't find this channel <#${channel.id}>. Has it been deleted?`
      );
      return;
    }
    await channel.permissionOverwrites.get(this.user.id)?.delete();
  }
}

export default ReactionRemove;
