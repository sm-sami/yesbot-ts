import { AutocompleteInteraction, Interaction, Snowflake } from "discord.js";
import glob from "fast-glob";
import path from "path";
import { createYesBotLogger } from "../log.js";
import { ErrorWithParams } from "./error-detail-replacer.js";
import {
  addEventHandler,
  EventHandlerOptions,
  extractEventInfo,
  HandlerFunction,
  isMessageRelated,
  rejectWithError,
} from "./events/events.js";
import { getIocName } from "./helper.js";
import {
  DiscordEvent,
  EventLocation,
  HandlerInfo,
  HandlerRejectedReason,
} from "./types/base.js";
import { CommandHandler, HandlerClass } from "./types/handler.js";
import {
  HIOC,
  InstanceOrConstructor,
  isHIOCArray,
  StringIndexedHIOCTree,
  StringIndexedHIOCTreeNode,
} from "./types/hioc.js";
import * as Sentry from "@sentry/node";
import { registerApplicationCommands } from "./register-commands.js";
import { fileURLToPath } from "node:url";

const logger = createYesBotLogger("event-distribution", "event-distribution");

export type EventDistributionHandlers = {
  [key in DiscordEvent]: StringIndexedHIOCTree<key>;
};

type FilterRejection<T extends DiscordEvent> = {
  handler: HIOC<T>;
  accepted: false;
  reason: HandlerRejectedReason;
};

type FilterResult<T extends DiscordEvent> =
  | { handler: HIOC<T>; accepted: true }
  | FilterRejection<T>;

const isRejection = <T extends DiscordEvent>(
  result: FilterResult<T>
): result is FilterRejection<T> => !result.accepted;

export class EventDistribution {
  handlers: EventDistributionHandlers = {
    [DiscordEvent.BUTTON_CLICKED]: {},
    [DiscordEvent.CONTEXT_MENU_MESSAGE]: {},
    [DiscordEvent.CONTEXT_MENU_USER]: {},
    [DiscordEvent.MEMBER_LEAVE]: {},
    [DiscordEvent.MESSAGE]: {},
    [DiscordEvent.REACTION_ADD]: {},
    [DiscordEvent.REACTION_REMOVE]: {},
    [DiscordEvent.GUILD_MEMBER_UPDATE]: {},
    [DiscordEvent.READY]: {},
    [DiscordEvent.SLASH_COMMAND]: {},
    [DiscordEvent.THREAD_CREATE]: {},
    [DiscordEvent.TIMER]: {},
    [DiscordEvent.VOICE_STATE_UPDATE]: {},
    [DiscordEvent.MEMBER_JOIN]: {},
  };

  private nameIdMap: Record<string, Snowflake> = {};

  private infoToFilterResults<T extends DiscordEvent>(
    info: HandlerInfo,
    event: T
  ): FilterResult<T>[] {
    const { handlerKeys, isDirectMessage, member, content = null } = info;

    const roleNames = member?.roles.cache.map((r) => r.name) ?? [];
    const eventHandlers = this.getHandlers<T>(
      this.handlers[event] as StringIndexedHIOCTreeNode<T>,
      handlerKeys
    );
    return this.filterHandlers<T>(
      eventHandlers,
      isDirectMessage,
      roleNames,
      content
    );
  }

  async handleInteraction(interaction: Interaction) {
    if (interaction.isButton()) {
      return await this.handleEvent(DiscordEvent.BUTTON_CLICKED, interaction);
    } else if (interaction.isChatInputCommand()) {
      return await this.handleEvent(DiscordEvent.SLASH_COMMAND, interaction);
    } else if (interaction.isMessageContextMenuCommand()) {
      return await this.handleEvent(
        DiscordEvent.CONTEXT_MENU_MESSAGE,
        interaction
      );
    } else if (interaction.isUserContextMenuCommand()) {
      return await this.handleEvent(
        DiscordEvent.CONTEXT_MENU_USER,
        interaction
      );
    } else if (interaction.isAutocomplete()) {
      return await this.handleAutocomplete(interaction);
    }
  }

  async handleAutocomplete(interaction: AutocompleteInteraction) {
    const options = interaction.options;

    const slashCommandHandlerKeys = [
      interaction.commandId,
      options.getSubcommandGroup(false) ?? "",
      options.getSubcommand(false) ?? "",
    ];

    const tree = this.handlers[DiscordEvent.SLASH_COMMAND];
    const handler = this.getHandlers<DiscordEvent.SLASH_COMMAND>(
      tree,
      slashCommandHandlerKeys
    );

    if (handler.length === 0) {
      logger.warn(
        `Received autocomplete for handlerkeys ${slashCommandHandlerKeys.join(
          ", "
        )}, but no handler was found!`
      );

      return;
    }

    const [slashCommandHioc] = handler;
    const focusedOption = options.getFocused(true);
    const focusedOptionName = focusedOption.name;

    const maybeAutocompleteOption = slashCommandHioc.options.options?.find(
      (o) => o.name === focusedOptionName
    );

    if (
      !maybeAutocompleteOption ||
      !("autocomplete" in maybeAutocompleteOption) ||
      !maybeAutocompleteOption.autocomplete
    ) {
      logger.warn(
        `Received autocomplete for handler ${getIocName(
          slashCommandHioc.ioc
        )} and option ${focusedOptionName} but no such option exists or it does not support autocomplete.`
      );

      return;
    }

    try {
      const response = await maybeAutocompleteOption.autocomplete(
        focusedOption.value,
        interaction
      );

      await interaction.respond(response);
    } catch (e) {
      logger.error("Failed to retrieve autocomplete information:", e);
      await interaction.respond([]);
    }
  }

  async handleEvent<T extends DiscordEvent>(
    event: T,
    ...args: Parameters<HandlerFunction<T>>
  ) {
    const infos = extractEventInfo(event, ...args);
    const filterResults = infos.flatMap((i) =>
      this.infoToFilterResults(i, event)
    );

    const acceptedHiocs = filterResults
      .filter(({ accepted }) => accepted)
      .map(({ handler }: FilterResult<T>) => handler);

    const completedIocs: InstanceOrConstructor<CommandHandler<T>>[] = [];

    for (const {
      ioc,
      options: { errors },
    } of acceptedHiocs) {
      if (completedIocs.includes(ioc)) continue;

      let instance = ioc;
      if (typeof instance === "function") instance = new instance();

      try {
        await instance.handle(...args);
      } catch (e) {
        const reason = e instanceof Error ? e.message : e + "";
        const hasParams = e instanceof ErrorWithParams;

        if (errors && errors[reason]) {
          const text = errors[reason];
          const error = hasParams
            ? new ErrorWithParams(text, e.params)
            : new Error(text);
          await rejectWithError(error, event, ...args);
        } else {
          Sentry.captureException(e, {
            extra: { event, args: JSON.stringify(args, null, 2) },
          });
          logger.error(`Error running handler ${getIocName(ioc)}: `, e);
        }
      }

      completedIocs.push(ioc);
    }

    const rejections = filterResults.filter(isRejection);
    for (const { handler, reason } of rejections) {
      const {
        options: { errors },
        ioc,
      } = handler;
      if (completedIocs.includes(ioc)) continue;
      if (!errors || !errors[reason]) continue;

      const text = errors[reason];
      await rejectWithError(new Error(text), event, ...args);

      completedIocs.push(ioc);
    }
  }

  addWithOptions<T extends EventHandlerOptions>(
    options: T,
    HandlerClass: HandlerClass<T["event"]>
  ) {
    const ioc = options.stateful ? new HandlerClass() : HandlerClass;
    const tree = this.handlers[options.event];
    addEventHandler(options, ioc, tree);
  }

  async initialize(): Promise<void> {
    const isProduction = process.env.NODE_ENV === "production";
    const extension = isProduction ? ".js" : ".ts";
    const directory = isProduction ? "build/src" : "src";

    const matches = await glob(`${directory}/programs/**/*${extension}`);

    const filename = fileURLToPath(import.meta.url);
    const dirname = path.dirname(filename);

    const loaders = matches
      .filter((p) => !p.endsWith(`.spec${extension}`))
      .map((p) => {
        const split = p.split(".");
        split.unshift();
        const moduleAbsolutePath = path.join(process.cwd(), split.join("."));
        const moduleRelativePath = path
          .relative(dirname, moduleAbsolutePath)
          .replace(".ts", ".js")
          .replace(/\\/g, "/");

        return import(moduleRelativePath);
      });

    try {
      await Promise.all(loaders);
    } catch (e) {
      logger.error("Error loading commands: ", e);
      throw e;
    }
    logger.debug("Loading complete!");

    // Slash Commands and related stuff

    const { userTree, messageTree, slashCommandTree, nameIdMap } =
      await registerApplicationCommands(
        this.handlers[DiscordEvent.SLASH_COMMAND],
        this.handlers[DiscordEvent.CONTEXT_MENU_MESSAGE],
        this.handlers[DiscordEvent.CONTEXT_MENU_USER]
      );

    this.nameIdMap = nameIdMap ?? {};
    this.handlers[DiscordEvent.SLASH_COMMAND] = slashCommandTree;
    this.handlers[DiscordEvent.CONTEXT_MENU_MESSAGE] = messageTree;
    this.handlers[DiscordEvent.CONTEXT_MENU_USER] = userTree;
  }

  private static isHandlerForLocation<T extends DiscordEvent>(
    handler: HIOC<T>,
    isDirectMessage: boolean
  ): boolean {
    if (!isMessageRelated(handler.options)) return true;

    const { location } = handler.options;
    switch (location) {
      case EventLocation.ANYWHERE:
        return true;
      case EventLocation.DIRECT_MESSAGE:
        return isDirectMessage;
      case EventLocation.SERVER:
        return !isDirectMessage;
    }

    return false;
  }

  private static isHandlerForRole<T extends DiscordEvent>(
    handler: HIOC<T>,
    roleNames: string[]
  ): boolean {
    if (!isMessageRelated(handler.options)) return true;

    const { allowedRoles } = handler.options;
    return (
      !allowedRoles?.length ||
      allowedRoles.some((role) => roleNames.includes(role))
    );
  }

  private static matchesContentRegex<T extends DiscordEvent>(
    handler: HIOC<T>,
    content: string | null
  ): boolean {
    if (!isMessageRelated(handler.options) || !handler.options.contentRegex)
      return true;
    if (content === null) return false;

    return !!content.match(handler.options.contentRegex);
  }

  private filterHandlers<T extends DiscordEvent>(
    handlers: HIOC<T>[],
    isDirectMessage: boolean,
    roleNames: string[],
    content: string | null
  ): FilterResult<T>[] {
    return handlers
      .map<FilterResult<T>>((eh) => {
        const isForLocation = EventDistribution.isHandlerForLocation(
          eh,
          isDirectMessage
        );
        return isForLocation
          ? { handler: eh, accepted: true }
          : {
              handler: eh,
              accepted: false,
              reason: HandlerRejectedReason.WRONG_LOCATION,
            };
      })
      .map<FilterResult<T>>((r) => {
        if (!r.accepted) return r;

        const isForRole = EventDistribution.isHandlerForRole(
          r.handler,
          roleNames
        );
        return isForRole
          ? r
          : {
              ...r,
              accepted: false,
              reason: HandlerRejectedReason.MISSING_ROLE,
            };
      })
      .map<FilterResult<T>>((r) => {
        if (!r.accepted) return r;

        const matchesContentRegex = EventDistribution.matchesContentRegex(
          r.handler,
          content
        );

        return matchesContentRegex
          ? r
          : {
              ...r,
              accepted: false,
              reason: HandlerRejectedReason.DOESNT_MATCH_REGEX,
            };
      });
  }

  private getHandlers<T extends DiscordEvent>(
    handlerTree: StringIndexedHIOCTreeNode<T>,
    [currentKey, ...restKeys]: string[]
  ): HIOC<T>[] {
    if (!handlerTree) return [];

    if (isHIOCArray(handlerTree)) return handlerTree;

    const handlers: HIOC<T>[] = [];
    handlers.push(...this.getHandlers(handlerTree[""], restKeys));

    if (!currentKey) {
      return handlers;
    }

    handlers.push(...this.getHandlers(handlerTree[currentKey], restKeys));

    return handlers;
  }

  public getIdForCommandName(commandName: string): Snowflake {
    return this.nameIdMap[commandName];
  }
}
