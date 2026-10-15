import { buildControlTimeline, selectionAt } from "../timeline/index.js";
const SC2_COMMAND_EVENT = "NNet.Game.SCmdEvent";
const SC2_POINT_SCALE = 4096;
function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : void 0;
}
function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : void 0;
}
function safeInteger(value) {
  const number = finiteNumber(value);
  return number !== void 0 && Number.isSafeInteger(number) ? number : void 0;
}
function userIdOf(event) {
  const direct = safeInteger(event["_userid"]);
  if (direct !== void 0) return direct;
  return safeInteger(record(event["_userid"])?.["m_userId"]);
}
function trackerPlayers(events) {
  const players = [];
  for (const event of events ?? []) {
    if (event.event !== "PlayerSetup") continue;
    players.push({
      playerId: event.playerId,
      type: event.type,
      ...event.userId === void 0 ? {} : { userId: event.userId },
      ...event.slotId === void 0 ? {} : { slotId: event.slotId }
    });
  }
  return players;
}
function parseAbility(value) {
  if (value === null || value === void 0) return void 0;
  const ability = record(value);
  if (ability === void 0) return void 0;
  const link = safeInteger(ability["m_abilLink"]);
  const commandIndex = safeInteger(ability["m_abilCmdIndex"]);
  const commandData = safeInteger(ability["m_abilCmdData"]);
  if (link === void 0 || commandIndex === void 0) return void 0;
  return {
    link,
    commandIndex,
    ...commandData === void 0 ? {} : { commandData }
  };
}
function scaledPoint(value) {
  const point = record(value);
  if (point === void 0) return void 0;
  const x = finiteNumber(point["x"]);
  const y = finiteNumber(point["y"]);
  const z = finiteNumber(point["z"]) ?? 0;
  if (x === void 0 || y === void 0) return void 0;
  return { x: x / SC2_POINT_SCALE, y: y / SC2_POINT_SCALE, z: z / SC2_POINT_SCALE };
}
function parseTarget(value) {
  const choice = record(value);
  if (choice === void 0) return void 0;
  if ("null" in choice || "None" in choice) return { kind: "none" };
  if ("TargetPoint" in choice) {
    const point = scaledPoint(choice["TargetPoint"]);
    return point === void 0 ? void 0 : { kind: "point", ...point };
  }
  if ("TargetUnit" in choice) {
    const target = record(choice["TargetUnit"]);
    const tag = safeInteger(target?.["m_tag"]);
    if (target === void 0 || tag === void 0) return void 0;
    const point = scaledPoint(target["m_snapshotPoint"]);
    const unitLink = safeInteger(target["m_snapshotUnitLink"]);
    const controlPlayer = safeInteger(target["m_snapshotControlPlayerId"]);
    const upkeepPlayer = safeInteger(target["m_snapshotUpkeepPlayerId"]);
    return {
      kind: "unit",
      tag,
      ...unitLink === void 0 ? {} : { unitLink },
      ...controlPlayer === void 0 ? {} : { controlPlayer },
      ...upkeepPlayer === void 0 ? {} : { upkeepPlayer },
      ...point === void 0 ? {} : { x: point.x, y: point.y }
    };
  }
  if ("Data" in choice) {
    const data = safeInteger(choice["Data"]);
    return data === void 0 ? void 0 : { kind: "data", value: data };
  }
  return void 0;
}
function normalizeSc2ReplayCommands(document, resolver, options = {}) {
  const gameEvents = document.decoded.gameEvents;
  const diagnostics = [];
  const maxIntents = options.maxIntents ?? 1e5;
  if (!Number.isSafeInteger(maxIntents) || maxIntents <= 0 || maxIntents > 1e5) {
    throw new RangeError("maxIntents must be a positive safe integer no greater than 100000");
  }
  if (gameEvents === void 0 || gameEvents.length === 0) {
    return {
      intents: [],
      commands: [],
      diagnostics: [
        {
          code: "game-events-unavailable",
          message: "Replay game events are unavailable; command normalization was skipped."
        }
      ]
    };
  }
  const players = document.timeline?.players ?? trackerPlayers(document.decoded.trackerEvents);
  const playerByUser = new Map(
    players.flatMap(
      (player) => player.userId === void 0 ? [] : [[player.userId, player.playerId]]
    )
  );
  const controls = buildControlTimeline(gameEvents, players);
  const replayBuild = document.decoded.header.version.baseBuild;
  const protocolBuild = document.decoded.protocolSupport?.selectedBuild ?? replayBuild;
  const protocolExact = document.decoded.protocolSupport?.exact ?? true;
  const intents = [];
  const commands = [];
  for (const [eventIndex, raw] of gameEvents.entries()) {
    const event = record(raw);
    if (event?.["_event"] !== SC2_COMMAND_EVENT) continue;
    if (intents.length >= maxIntents) {
      diagnostics.push({
        code: "intent-limit",
        message: `Replay command intents were truncated at ${maxIntents} entries.`,
        eventIndex
      });
      break;
    }
    const loop = safeInteger(event["_gameloop"]);
    const userId = userIdOf(event);
    const sequence = safeInteger(event["m_sequence"]);
    const flags = safeInteger(event["m_cmdFlags"]);
    const target = parseTarget(event["m_data"]);
    if (loop === void 0 || loop < 0 || userId === void 0 || sequence === void 0 || sequence < 0 || flags === void 0 || target === void 0) {
      diagnostics.push({
        code: "malformed-command",
        message: "A decoded SCmdEvent is missing a required normalized field.",
        eventIndex,
        ...loop === void 0 ? {} : { loop },
        ...userId === void 0 ? {} : { userId }
      });
      continue;
    }
    const player = playerByUser.get(userId);
    if (player === void 0) {
      diagnostics.push({
        code: "player-unmapped",
        message: `Replay user ${userId} has no tracker-authoritative player mapping.`,
        eventIndex,
        loop,
        userId
      });
      continue;
    }
    const selectionTrack = controls.players.get(player);
    if (selectionTrack === void 0) {
      diagnostics.push({
        code: "selection-unavailable",
        message: `Replay player ${player} has no reconstructable selection at command loop ${loop}.`,
        eventIndex,
        loop,
        userId
      });
      continue;
    }
    const ability = parseAbility(event["m_abil"]);
    if (event["m_abil"] !== null && event["m_abil"] !== void 0 && ability === void 0) {
      diagnostics.push({
        code: "malformed-command",
        message: "A decoded SCmdEvent contains an incomplete ability reference.",
        eventIndex,
        loop,
        userId
      });
      continue;
    }
    const intent = {
      id: `sc2-replay:${replayBuild}:${eventIndex}`,
      replayBuild,
      protocolBuild,
      protocolExact,
      loop,
      userId,
      player,
      sequence,
      flags,
      unitTags: [...selectionAt(selectionTrack, loop)],
      ...ability === void 0 ? {} : { ability },
      target
    };
    intents.push(intent);
    if (resolver === void 0) continue;
    const command = resolver.resolve(intent);
    if (command === void 0) {
      diagnostics.push({
        code: "command-unresolved",
        message: `Replay command '${intent.id}' could not be resolved without guessing its catalog semantics.`,
        eventIndex,
        loop,
        userId
      });
      continue;
    }
    commands.push({
      id: intent.id,
      loop,
      player,
      sequence,
      command
    });
  }
  return { intents, commands, diagnostics };
}
export {
  normalizeSc2ReplayCommands
};
