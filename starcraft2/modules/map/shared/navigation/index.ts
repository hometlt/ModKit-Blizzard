/**
 * Map navigation analysis: a strategic, multimodal navigation graph (ground, ramps, destructible
 * and mineral-wall passages, cliff-walker and transport portals, expansions) built from a map's
 * real terrain, pathing, placement and object data, with routing, runtime blocker state,
 * serialization and debug drawing. See `docs/map-navigation-analysis.md`.
 */

export * from './grid.js'
export * from './areas.js'
export * from './refine.js'
export * from './spatial.js'
export { sc2MapSpatialData } from './sc2-spatial.js'
export * from './analyze.js'
export * from './routes.js'
export * from './render.js'
