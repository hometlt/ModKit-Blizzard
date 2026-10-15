const GAME_LOOPS_PER_SECOND = 16;
const GAME_SPEED_MULTIPLIERS = {
  slower: 0.6,
  slow: 0.8,
  normal: 1,
  fast: 1.2,
  faster: 1.4
};
const MIN_SPEED = 0.25;
const MAX_SPEED = 16;
class PlaybackClock {
  durationLoops;
  loop = 0;
  playing = false;
  userSpeed;
  gameSpeedMultiplier;
  constructor(options) {
    this.durationLoops = Math.max(0, options.durationLoops);
    this.gameSpeedMultiplier = GAME_SPEED_MULTIPLIERS[options.gameSpeed ?? "faster"];
    this.userSpeed = clampSpeed(options.speed ?? 1);
  }
  get speed() {
    return this.userSpeed;
  }
  setSpeed(speed) {
    this.userSpeed = clampSpeed(speed);
  }
  setGameSpeed(name) {
    this.gameSpeedMultiplier = GAME_SPEED_MULTIPLIERS[name];
  }
  /** Game loops advanced per real second at the current settings. */
  get loopsPerRealSecond() {
    return GAME_LOOPS_PER_SECOND * this.gameSpeedMultiplier * this.userSpeed;
  }
  play() {
    if (this.loop >= this.durationLoops) this.loop = 0;
    this.playing = true;
  }
  pause() {
    this.playing = false;
  }
  toggle() {
    if (this.playing) this.pause();
    else this.play();
  }
  seekLoop(loop) {
    this.loop = Math.min(Math.max(loop, 0), this.durationLoops);
  }
  /** Seek by real-time seconds at the current game speed (user speed excluded). */
  seekSeconds(seconds) {
    this.seekLoop(seconds * GAME_LOOPS_PER_SECOND * this.gameSpeedMultiplier);
  }
  /** Real-time position in seconds at the current game speed. */
  get seconds() {
    return this.loop / (GAME_LOOPS_PER_SECOND * this.gameSpeedMultiplier);
  }
  get durationSeconds() {
    return this.durationLoops / (GAME_LOOPS_PER_SECOND * this.gameSpeedMultiplier);
  }
  /**
   * Advance by a real-time frame delta; pauses automatically at the end.
   * Returns the new loop position.
   */
  advance(realDeltaSeconds) {
    if (!this.playing) return this.loop;
    this.loop += realDeltaSeconds * this.loopsPerRealSecond;
    if (this.loop >= this.durationLoops) {
      this.loop = this.durationLoops;
      this.playing = false;
    } else if (this.loop < 0) {
      this.loop = 0;
    }
    return this.loop;
  }
}
function clampSpeed(speed) {
  return Math.min(Math.max(speed, MIN_SPEED), MAX_SPEED);
}
export {
  GAME_LOOPS_PER_SECOND,
  GAME_SPEED_MULTIPLIERS,
  PlaybackClock
};
