function buildReplayTimeline(events) {
  const typeNames = [];
  const typeIds = /* @__PURE__ */ new Map();
  const internType = (name) => {
    let id = typeIds.get(name);
    if (id === void 0) {
      id = typeNames.length;
      typeNames.push(name);
      typeIds.set(name, id);
    }
    return id;
  };
  const units = [];
  const liveByIndex = /* @__PURE__ */ new Map();
  const upgrades = [];
  const stats = /* @__PURE__ */ new Map();
  const players = [];
  let durationLoops = 0;
  const spawn = (event, initOnly) => {
    const track = {
      tag: event.unitTag,
      tagIndex: event.unitTagIndex,
      typeId: internType(event.unitTypeName),
      controlPlayerId: event.controlPlayerId,
      bornLoop: event.gameloop,
      initOnly,
      samples: [event.gameloop, event.x, event.y]
    };
    units.push(track);
    liveByIndex.set(event.unitTagIndex, track);
  };
  for (const event of events) {
    if (event.gameloop > durationLoops) durationLoops = event.gameloop;
    switch (event.event) {
      case "UnitBorn":
        spawn(event, false);
        break;
      case "UnitInit":
        spawn(event, true);
        break;
      case "UnitDone": {
        const track = liveByIndex.get(event.unitTagIndex);
        if (track && track.tag === event.unitTag) track.doneLoop = event.gameloop;
        break;
      }
      case "UnitDied": {
        const track = liveByIndex.get(event.unitTagIndex);
        if (track && track.tag === event.unitTag) {
          track.diedLoop = event.gameloop;
          if (event.killerPlayerId !== void 0) track.killerPlayerId = event.killerPlayerId;
          if (event.killerUnitTagIndex !== void 0 && event.killerUnitTagRecycle !== void 0) {
            track.killerTag = event.killerUnitTagIndex * (1 << 18) + event.killerUnitTagRecycle;
          }
          track.samples.push(event.gameloop, event.x, event.y);
          liveByIndex.delete(event.unitTagIndex);
        }
        break;
      }
      case "UnitPositions": {
        for (const { unitIndex, x, y } of event.units) {
          const track = liveByIndex.get(unitIndex);
          if (track) track.samples.push(event.gameloop, x, y);
        }
        break;
      }
      case "UnitTypeChange": {
        const track = liveByIndex.get(event.unitTagIndex);
        if (track && track.tag === event.unitTag) {
          ;
          (track.typeChanges ??= []).push({
            loop: event.gameloop,
            typeId: internType(event.unitTypeName)
          });
        }
        break;
      }
      case "UnitOwnerChange": {
        const track = liveByIndex.get(event.unitTagIndex);
        if (track && track.tag === event.unitTag) {
          ;
          (track.ownerChanges ??= []).push({
            loop: event.gameloop,
            playerId: event.controlPlayerId
          });
        }
        break;
      }
      case "Upgrade":
        upgrades.push({
          loop: event.gameloop,
          playerId: event.playerId,
          name: event.upgradeTypeName,
          count: event.count
        });
        break;
      case "PlayerStats": {
        let samples = stats.get(event.playerId);
        if (!samples) {
          samples = [];
          stats.set(event.playerId, samples);
        }
        samples.push({ loop: event.gameloop, stats: event.stats });
        break;
      }
      case "PlayerSetup":
        players.push({
          playerId: event.playerId,
          type: event.type,
          ...event.userId !== void 0 ? { userId: event.userId } : {},
          ...event.slotId !== void 0 ? { slotId: event.slotId } : {}
        });
        break;
      default:
        break;
    }
  }
  units.sort((a, b) => a.bornLoop - b.bornLoop);
  return { durationLoops, units, typeNames, upgrades, stats, players };
}
function unitAliveAt(track, loop) {
  return loop >= track.bornLoop && (track.diedLoop === void 0 || loop < track.diedLoop);
}
function unitPositionAt(track, loop, out = [0, 0]) {
  const samples = track.samples;
  const count = samples.length / 3;
  if (count === 0) {
    out[0] = 0;
    out[1] = 0;
    return out;
  }
  if (loop <= samples[0]) {
    out[0] = samples[1];
    out[1] = samples[2];
    return out;
  }
  const lastBase = (count - 1) * 3;
  if (loop >= samples[lastBase]) {
    out[0] = samples[lastBase + 1];
    out[1] = samples[lastBase + 2];
    return out;
  }
  let lo = 0;
  let hi = count - 1;
  while (hi - lo > 1) {
    const mid = lo + hi >> 1;
    if (samples[mid * 3] <= loop) lo = mid;
    else hi = mid;
  }
  const la = samples[lo * 3];
  const lb = samples[hi * 3];
  const t = lb > la ? (loop - la) / (lb - la) : 0;
  out[0] = samples[lo * 3 + 1] + (samples[hi * 3 + 1] - samples[lo * 3 + 1]) * t;
  out[1] = samples[lo * 3 + 2] + (samples[hi * 3 + 2] - samples[lo * 3 + 2]) * t;
  return out;
}
function unitTypeIdAt(track, loop) {
  let typeId = track.typeId;
  if (track.typeChanges) {
    for (const change of track.typeChanges) {
      if (change.loop > loop) break;
      typeId = change.typeId;
    }
  }
  return typeId;
}
function unitOwnerAt(track, loop) {
  let owner = track.controlPlayerId;
  if (track.ownerChanges) {
    for (const change of track.ownerChanges) {
      if (change.loop > loop) break;
      owner = change.playerId;
    }
  }
  return owner;
}
function playerStatsAt(timeline, playerId, loop) {
  const samples = timeline.stats.get(playerId);
  if (!samples || samples.length === 0) return null;
  let lo = 0;
  let hi = samples.length - 1;
  if (samples[0].loop > loop) return null;
  while (hi - lo > 1) {
    const mid = lo + hi >> 1;
    if (samples[mid].loop <= loop) lo = mid;
    else hi = mid;
  }
  return samples[hi].loop <= loop ? samples[hi] : samples[lo];
}
export {
  buildReplayTimeline,
  playerStatsAt,
  unitAliveAt,
  unitOwnerAt,
  unitPositionAt,
  unitTypeIdAt
};
