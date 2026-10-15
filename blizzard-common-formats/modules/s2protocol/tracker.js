import {
  VersionedReader,
  asStruct,
  asArray,
  asNumber,
  asString
} from "./versioned.js";
function num(v, dflt = 0) {
  return v === void 0 || v === null ? dflt : asNumber(v);
}
function str(v) {
  return v === void 0 || v === null ? "" : asString(v);
}
function optNum(v) {
  return v === void 0 || v === null ? void 0 : asNumber(v);
}
function choiceValue(v) {
  const s = asStruct(v);
  const k = Object.keys(s)[0];
  return k === void 0 ? 0 : num(s[Number(k)]);
}
function unitTag(index, recycle) {
  return index * (1 << 18) + recycle;
}
const EVENT_NAMES = {
  0: "PlayerStats",
  1: "UnitBorn",
  2: "UnitDied",
  3: "UnitOwnerChange",
  4: "UnitTypeChange",
  5: "Upgrade",
  6: "UnitInit",
  7: "UnitDone",
  8: "UnitPositions",
  9: "PlayerSetup"
};
function decodeStats(v) {
  const s = asStruct(v);
  return {
    mineralsCurrent: num(s[0]),
    vespeneCurrent: num(s[1]),
    mineralsCollectionRate: num(s[2]),
    vespeneCollectionRate: num(s[3]),
    workersActiveCount: num(s[4]),
    mineralsUsedInProgressArmy: num(s[5]),
    mineralsUsedInProgressEconomy: num(s[6]),
    mineralsUsedInProgressTechnology: num(s[7]),
    vespeneUsedInProgressArmy: num(s[8]),
    vespeneUsedInProgressEconomy: num(s[9]),
    vespeneUsedInProgressTechnology: num(s[10]),
    mineralsUsedCurrentArmy: num(s[11]),
    mineralsUsedCurrentEconomy: num(s[12]),
    mineralsUsedCurrentTechnology: num(s[13]),
    vespeneUsedCurrentArmy: num(s[14]),
    vespeneUsedCurrentEconomy: num(s[15]),
    vespeneUsedCurrentTechnology: num(s[16]),
    mineralsLostArmy: num(s[17]),
    mineralsLostEconomy: num(s[18]),
    mineralsLostTechnology: num(s[19]),
    vespeneLostArmy: num(s[20]),
    vespeneLostEconomy: num(s[21]),
    vespeneLostTechnology: num(s[22]),
    mineralsKilledArmy: num(s[23]),
    mineralsKilledEconomy: num(s[24]),
    mineralsKilledTechnology: num(s[25]),
    vespeneKilledArmy: num(s[26]),
    vespeneKilledEconomy: num(s[27]),
    vespeneKilledTechnology: num(s[28]),
    foodUsed: num(s[29]) / 4096,
    foodMade: num(s[30]) / 4096,
    mineralsUsedActiveForces: num(s[31]),
    vespeneUsedActiveForces: num(s[32])
  };
}
function decodeUnitPositions(s) {
  const items = s[1] === void 0 ? [] : asArray(s[1]).map(asNumber);
  const out = [];
  let unitIndex = num(s[0]);
  for (let i = 0; i + 2 < items.length + 1 && i + 2 < items.length; i += 3) {
    unitIndex += items[i];
    out.push({ unitIndex, x: items[i + 1] * 4, y: items[i + 2] * 4 });
  }
  return out;
}
function buildEvent(eventid, gameloop, body) {
  const s = asStruct(body);
  const base = { gameloop, eventid };
  switch (EVENT_NAMES[eventid]) {
    case "PlayerStats":
      return { ...base, event: "PlayerStats", playerId: num(s[0]), stats: decodeStats(s[1]) };
    case "UnitBorn": {
      const event = {
        ...base,
        event: "UnitBorn",
        unitTagIndex: num(s[0]),
        unitTagRecycle: num(s[1]),
        unitTag: unitTag(num(s[0]), num(s[1])),
        unitTypeName: str(s[2]),
        controlPlayerId: num(s[3]),
        upkeepPlayerId: num(s[4]),
        x: num(s[5]),
        y: num(s[6])
      };
      const creatorUnitTagIndex = optNum(s[7]);
      const creatorUnitTagRecycle = optNum(s[8]);
      if (creatorUnitTagIndex !== void 0) event.creatorUnitTagIndex = creatorUnitTagIndex;
      if (creatorUnitTagRecycle !== void 0) event.creatorUnitTagRecycle = creatorUnitTagRecycle;
      if (s[9] != null) event.creatorAbilityName = str(s[9]);
      return event;
    }
    case "UnitDied": {
      const event = {
        ...base,
        event: "UnitDied",
        unitTagIndex: num(s[0]),
        unitTagRecycle: num(s[1]),
        unitTag: unitTag(num(s[0]), num(s[1])),
        x: num(s[3]),
        y: num(s[4])
      };
      const killerPlayerId = optNum(s[2]);
      const killerUnitTagIndex = optNum(s[5]);
      const killerUnitTagRecycle = optNum(s[6]);
      if (killerPlayerId !== void 0) event.killerPlayerId = killerPlayerId;
      if (killerUnitTagIndex !== void 0) event.killerUnitTagIndex = killerUnitTagIndex;
      if (killerUnitTagRecycle !== void 0) event.killerUnitTagRecycle = killerUnitTagRecycle;
      return event;
    }
    case "UnitOwnerChange":
      return {
        ...base,
        event: "UnitOwnerChange",
        unitTagIndex: num(s[0]),
        unitTagRecycle: num(s[1]),
        unitTag: unitTag(num(s[0]), num(s[1])),
        controlPlayerId: num(s[2]),
        upkeepPlayerId: num(s[3])
      };
    case "UnitTypeChange":
      return {
        ...base,
        event: "UnitTypeChange",
        unitTagIndex: num(s[0]),
        unitTagRecycle: num(s[1]),
        unitTag: unitTag(num(s[0]), num(s[1])),
        unitTypeName: str(s[2])
      };
    case "Upgrade":
      return { ...base, event: "Upgrade", playerId: num(s[0]), upgradeTypeName: str(s[1]), count: num(s[2]) };
    case "UnitInit":
      return {
        ...base,
        event: "UnitInit",
        unitTagIndex: num(s[0]),
        unitTagRecycle: num(s[1]),
        unitTag: unitTag(num(s[0]), num(s[1])),
        unitTypeName: str(s[2]),
        controlPlayerId: num(s[3]),
        upkeepPlayerId: num(s[4]),
        x: num(s[5]),
        y: num(s[6])
      };
    case "UnitDone":
      return {
        ...base,
        event: "UnitDone",
        unitTagIndex: num(s[0]),
        unitTagRecycle: num(s[1]),
        unitTag: unitTag(num(s[0]), num(s[1]))
      };
    case "UnitPositions":
      return { ...base, event: "UnitPositions", firstUnitIndex: num(s[0]), units: decodeUnitPositions(s) };
    case "PlayerSetup": {
      const event = { ...base, event: "PlayerSetup", playerId: num(s[0]), type: num(s[1]) };
      const userId = optNum(s[2]);
      const slotId = optNum(s[3]);
      if (userId !== void 0) event.userId = userId;
      if (slotId !== void 0) event.slotId = slotId;
      return event;
    }
    default:
      return { ...base, event: "Raw", fields: s };
  }
}
function decodeTrackerEvents(bytes, options = {}) {
  const reader = new VersionedReader(bytes, options);
  const events = [];
  const maxEvents = options.maxEvents ?? options.maxNodes ?? 1e5;
  let gameloop = 0;
  while (!reader.done) {
    options.signal?.throwIfAborted();
    if (events.length >= maxEvents) throw new RangeError(`s2protocol: exceeds ${maxEvents} tracker events`);
    gameloop += choiceValue(reader.read());
    const eventid = asNumber(reader.read());
    const body = reader.read();
    events.push(buildEvent(eventid, gameloop, body));
  }
  return events;
}
export {
  decodeTrackerEvents,
  unitTag
};
