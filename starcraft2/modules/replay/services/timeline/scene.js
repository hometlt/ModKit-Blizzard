import {
  unitAliveAt,
  unitOwnerAt,
  unitPositionAt,
  unitTypeIdAt
} from "./timeline.js";
class ReplayScene {
  constructor(timeline) {
    this.timeline = timeline;
    this.tracks = timeline.units;
    const capacity = timeline.units.length;
    this.frame = {
      loop: 0,
      count: 0,
      tags: new Float64Array(capacity),
      positions: new Float32Array(capacity * 2),
      playerIds: new Uint8Array(capacity),
      typeIds: new Uint16Array(capacity),
      trackIndices: new Uint32Array(capacity),
      underConstruction: new Uint8Array(capacity)
    };
  }
  timeline;
  frame;
  scratch = [0, 0];
  /** Tracks sorted by bornLoop (timeline guarantees it). */
  tracks;
  /**
   * Alive units at a loop, positions interpolated between tracker samples.
   * The returned frame's buffers are reused across calls — copy out anything
   * that must survive the next sample.
   */
  sampleAt(loop) {
    const frame = this.frame;
    frame.loop = loop;
    let count = 0;
    for (let trackIndex = 0; trackIndex < this.tracks.length; trackIndex += 1) {
      const track = this.tracks[trackIndex];
      if (track.bornLoop > loop) break;
      if (!unitAliveAt(track, loop)) continue;
      const position = unitPositionAt(track, loop, this.scratch);
      frame.tags[count] = track.tag;
      frame.positions[count * 2] = position[0];
      frame.positions[count * 2 + 1] = position[1];
      frame.playerIds[count] = unitOwnerAt(track, loop);
      frame.typeIds[count] = unitTypeIdAt(track, loop);
      frame.trackIndices[count] = trackIndex;
      frame.underConstruction[count] = track.initOnly && (track.doneLoop === void 0 || track.doneLoop > loop) ? 1 : 0;
      count += 1;
    }
    frame.count = count;
    return frame;
  }
  /** Alive-unit count without filling buffers (progress bars, tests). */
  countAliveAt(loop) {
    let count = 0;
    for (const track of this.tracks) {
      if (track.bornLoop > loop) break;
      if (unitAliveAt(track, loop)) count += 1;
    }
    return count;
  }
}
export {
  ReplayScene
};
