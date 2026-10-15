import { playerStatsAt } from "./timeline.js";
const ACTIVE_GROUP = 10;
const num = (v) => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "bigint") return Number(v);
  return void 0;
};
function userIdOf(event) {
  const raw = event._userid;
  const direct = num(raw);
  if (direct !== void 0) return direct;
  if (raw && typeof raw === "object") {
    return num(raw["m_userId"]);
  }
  return void 0;
}
function applyRemoveMask(tags, mask) {
  if (!mask || typeof mask !== "object") return tags;
  const record = mask;
  if ("None" in record) return tags;
  if ("ZeroIndices" in record) {
    const keep = new Set(record["ZeroIndices"].map((v) => num(v) ?? -1));
    return tags.filter((_tag, index) => keep.has(index));
  }
  if ("OneIndices" in record) {
    const remove = new Set(record["OneIndices"].map((v) => num(v) ?? -1));
    return tags.filter((_tag, index) => !remove.has(index));
  }
  if ("Mask" in record) {
    const packed = record["Mask"];
    if (!Array.isArray(packed)) return tags;
    const length = num(packed[0]) ?? 0;
    const bits = typeof packed[1] === "bigint" ? packed[1] : BigInt(num(packed[1]) ?? 0);
    return tags.filter((_tag, index) => {
      if (index >= length) return true;
      return (bits >> BigInt(length - 1 - index) & 1n) === 0n;
    });
  }
  return tags;
}
function buildControlTimeline(gameEvents, players) {
  const diagnostics = [];
  const tracks = /* @__PURE__ */ new Map();
  if (!gameEvents || gameEvents.length === 0) {
    diagnostics.push("no-protocol: game events unavailable \u2014 selection tracks disabled");
    return { players: tracks, diagnostics };
  }
  const playerByUser = /* @__PURE__ */ new Map();
  for (const player of players) {
    if (player.userId !== void 0) playerByUser.set(player.userId, player.playerId);
  }
  const groupsByUser = /* @__PURE__ */ new Map();
  const groupsFor = (userId) => {
    let groups = groupsByUser.get(userId);
    if (!groups) {
      groups = Array.from({ length: ACTIVE_GROUP + 1 }, () => []);
      groupsByUser.set(userId, groups);
    }
    return groups;
  };
  const trackFor = (userId) => {
    const playerId = playerByUser.get(userId) ?? userId + 1;
    let track = tracks.get(playerId);
    if (!track) {
      track = { playerId, selection: [] };
      tracks.set(playerId, track);
    }
    return track;
  };
  const checkpoint = (userId, loop, tags) => {
    const track = trackFor(userId);
    const last = track.selection[track.selection.length - 1];
    if (last && last.loop === loop) last.tags = [...tags];
    else track.selection.push({ loop, tags: [...tags] });
  };
  let deltaCount = 0;
  for (const raw of gameEvents) {
    const event = raw;
    const name = typeof event._event === "string" ? event._event : "";
    if (!name.endsWith("SSelectionDeltaEvent") && !name.endsWith("SControlGroupUpdateEvent")) {
      continue;
    }
    const userId = userIdOf(event);
    const loop = num(event._gameloop) ?? 0;
    if (userId === void 0) continue;
    const groups = groupsFor(userId);
    if (name.endsWith("SSelectionDeltaEvent")) {
      const groupId = Math.min(num(event["m_controlGroupId"]) ?? ACTIVE_GROUP, ACTIVE_GROUP);
      const delta = event["m_delta"];
      if (!delta) continue;
      const tags = applyRemoveMask(groups[groupId], delta["m_removeMask"]);
      const added = delta["m_addUnitTags"];
      if (Array.isArray(added)) {
        for (const value of added) {
          const tag = num(value);
          if (tag !== void 0) tags.push(tag);
        }
      }
      groups[groupId] = tags;
      deltaCount += 1;
      if (groupId === ACTIVE_GROUP) checkpoint(userId, loop, tags);
    } else {
      const index = Math.min(num(event["m_controlGroupIndex"]) ?? 0, ACTIVE_GROUP - 1);
      const update = num(event["m_controlGroupUpdate"]) ?? 0;
      switch (update) {
        case 0:
        // assign (and 3 = steal-assign, approximated)
        case 3:
          groups[index] = [...groups[ACTIVE_GROUP]];
          break;
        case 1:
        // append (and 4 = steal-append, approximated)
        case 4: {
          const merged = groups[index];
          const present = new Set(merged);
          for (const tag of groups[ACTIVE_GROUP]) {
            if (!present.has(tag)) merged.push(tag);
          }
          break;
        }
        case 2: {
          const recalled = applyRemoveMask([...groups[index]], event["m_mask"]);
          groups[index] = recalled;
          groups[ACTIVE_GROUP] = [...recalled];
          checkpoint(userId, loop, recalled);
          break;
        }
        default:
          break;
      }
    }
  }
  if (deltaCount === 0) {
    diagnostics.push("no-selection-events: protocol decoded but no selection deltas found");
  }
  return { players: tracks, diagnostics };
}
function selectionAt(track, loop) {
  const snapshots = track.selection;
  if (snapshots.length === 0 || snapshots[0].loop > loop) return [];
  let lo = 0;
  let hi = snapshots.length - 1;
  while (hi - lo > 1) {
    const mid = lo + hi >> 1;
    if (snapshots[mid].loop <= loop) lo = mid;
    else hi = mid;
  }
  return snapshots[hi].loop <= loop ? snapshots[hi].tags : snapshots[lo].tags;
}
function hudStateAt(timeline, playerId, loop) {
  const sample = playerStatsAt(timeline, playerId, loop);
  if (!sample) return null;
  const stats = sample.stats;
  return {
    loop: sample.loop,
    minerals: stats.mineralsCurrent,
    vespene: stats.vespeneCurrent,
    mineralsRate: stats.mineralsCollectionRate,
    vespeneRate: stats.vespeneCollectionRate,
    supplyUsed: stats.foodUsed,
    supplyCap: stats.foodMade,
    workersActive: stats.workersActiveCount,
    armyValueMinerals: stats.mineralsUsedCurrentArmy,
    armyValueVespene: stats.vespeneUsedCurrentArmy
  };
}
export {
  buildControlTimeline,
  hudStateAt,
  selectionAt
};
