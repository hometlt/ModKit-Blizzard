import {
  createStarcraft2LaunchPlan,
  interpretSc2Log,
} from '../../../../dist/modules/game/providers/launch/src/launch.js'

const CONTRACT = 'common.game/launch-plan'
const GAME_ID = 'blizzard/starcraft-2'
const PLANNER_ID = 'blizzard/starcraft2-native-map-launch'

export const abiVersion = 1
export const provides = Object.freeze([CONTRACT])

export function createProvider(selection) {
  if (selection.contract !== CONTRACT || selection.major !== 1) {
    throw new TypeError(
      `unsupported game-launch selection ${selection.contract}@${selection.major}`,
    )
  }
  return Object.freeze({
    value: Object.freeze({
      contract: CONTRACT,
      plannerId: PLANNER_ID,
      gameIds: Object.freeze([GAME_ID]),
      plan: createStarcraft2LaunchPlan,
      interpretLog: interpretSc2Log,
    }),
    release: async () => undefined,
  })
}
