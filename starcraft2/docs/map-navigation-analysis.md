# SC2 map navigation analysis

A strategic, multimodal navigation graph for AI, built before the game from a map's own terrain,
pathing, placement and object data. It is a module of its own:
`modules/map/shared/navigation/`.

`refine.ts` adds sub-cell ground connectivity and passage-axis vertices using the same generic
grid routines; strategic placement and expansion scoring keep their original source resolution.

| File             | Contents                                                                                                                             |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `grid.ts`        | Game-agnostic grid algorithms: components, octile distance fields, clearance, rasterization, disjoint sets, spatial hash, clustering |
| `spatial.ts`     | The normalized map (`MapSpatialData`) and the masks derived from it                                                                  |
| `areas.ts`       | Connected geodesic territories, protected resource neighbourhoods, maximum radius                                                    |
| `sc2-spatial.ts` | StarCraft II documents + resolved catalog → `MapSpatialData`                                                                         |
| `analyze.ts`     | Regions, ramps, expansions, destructible / mineral-wall / cliff / pre-drop portals, accessibility, the graph                         |
| `routes.ts`      | Runtime blocker state, edge costs, Dijkstra, Yen K-shortest, route classes, serialization, compact form                              |
| `render.ts`      | Debug drawing over the map overview (minimap), per layer, with routes                                                                |

Tests: `test/mk2/codecs/sc2-map/test/navigation/navigation.test.ts` (synthetic maps, the 14
required cases). The map codec draws it as the `navigation` layer of `view.render`
(`{ layer: 'navigation', catalog, route: [from, to], layers: {…} }`). A command-line run on a real
map: `reports/tools/sc2-map-nav/nav-map.ts`.

## Source data

Everything is read through the existing SC2 map parsers (`@modkitx/maps-processing/sc2-map-core`)
and the map overview's analysis functions; nothing is parsed twice.

| Source                                                                  | Used for                                                                                                                                                                                                                                          |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `t3HeightMap` `heightAdjustments` + `t3Terrain.xml` `vertData`          | Cliff level per vertex (`analyzeVertexCliffLevels`): a cell whose corners span a cliff step (≥ 3 CLIF units) is a cliff face; a cell with uneven corners or corners off a whole level (> 0.5) is a ramp slope                                     |
| `CellAttribute_Pnp`                                                     | Painted no-pathing (any non-zero value; mirrored brush strokes store `v` or `255 - v`)                                                                                                                                                            |
| `t3Terrain.xml` ramp frames and cliff lattice                           | Authored ramp axes, extents and levels; cliff polylines shared with the minimap                                                                                                                                                                   |
| `CellAttribute_Pnb`                                                     | Painted no-building                                                                                                                                                                                                                               |
| `CellAttribute_Pcl`                                                     | Painted clear pathing: walkable even across a cliff face or no-pathing (Amphion: the passages beside the centre pits)                                                                                                                             |
| `MapInfo`                                                               | Playable bounds: everything outside is unwalkable                                                                                                                                                                                                 |
| `Objects` (units, doodads, `StartLoc` points)                           | Placed objects with position, rotation, `Resources` override, `NoDoodadFootprint` flag                                                                                                                                                            |
| Resolved catalog (`CUnit`, `CActor`, `CFootprint`, `CBehaviorResource`) | Kind (`EditorCategories` `ObjectType:Resource/Destructible`, `ResourceType`), footprint cells turned with the object (`GroundNoSpawn` blocks walking, `NoBuild` building, `NearResources` town halls), `LifeMax`, resource `Contents`, rich yield |

The catalog is the resolved snapshot the map's 3D scene is built from (inheritance applied);
`test/amphion-product-route.test.ts` dumps it with `MODKIT_CATALOG_DUMP`.

Not available and therefore not used: SC2's own sub-cell pathing (the engine's footprint pathing
is finer than cells), unit pathing radii per unit type, and water depth. Amphion has no
`t3SyncPathingInfo`.

**Coordinates.** Terrain cells, one per world unit, row-major `y * width + x`, `y = 0` at the
map's bottom; a cell's centre is `(x + 0.5, y + 0.5)`. The grid is the height map's vertex grid
minus one (Amphion 176 × 176). Footprints are placed on the cell holding the object's position
and turn in quarter turns unless the unit is not `Turnable`.

## Normalized map

```ts
MapSpatialData {
  width, height, bounds
  terrainWalkable   // walkable with every removable blocker gone
  terrainBuildable  // buildable with every removable blocker gone (flat, not painted no-build)
  ramp, cliff, painted, level
  rampShapes[]      // optional authored frames with low/high endpoints and levels
  cliffCrossings[]  // optional crossings verified against minimap cliff geometry
  blockers[]        // { id, kind: destructible | mineral | geyser | neutral, cells, placementCells,
                    //   nearResourceCells, life, resources, rich }
  startLocations[]
  groundSampling?  // {width,height,cellSize,walkable,level,ramp}: finer current movement grid
}
```

Terrain and blockers stay apart, so "walkable now", "walkable if these rocks were gone" and
"buildable after the blocker disappears" are all `walkableMask(data, present)` /
`buildableMask(data, present)` with a different set of blockers. Doodad footprints are permanent
terrain; units become blockers. Any game can fill this structure (`blankSpatialData` starts one).

## Analysis

1. **Regions.** 4-connected components of cells walkable now and not on a ramp; components below
   `minRegionArea` are dropped. Adjacent open cells separated by a whole cliff step are not
   connected: `canGroundStep` rejects level differences ≥ 0.75 unless a ramp cell participates.
   The same predicate applies to distance fields and reconstruction, including diagonal corner
   steps. Ids `R1…` follow row-major order. Each region has a level, area,
   bounds and a centre snapped to a roomy cell (clearance field).
2. **Ramps.** SC2 uses the authored frames, with slope extents from the same height sampling as
   the minimap. Lower and upper entries must lie on the corresponding level and side. Blocked
   slopes are retained; they do not acquire unconditional ramp edges. Generic spatial maps
   without frames use connected slope cells. Staging points stand
   `stagingDistance` cells beyond each entry, snapped to a cell of the right region with
   `stagingClearance`, never on the ramp.
3. **Destructible passages and mineral walls** (one algorithm, two blocker kinds). Blockers
   within `blockerGroupGap` form one barrier. Its walkable cells are freed; the region cells
   touching them, clustered, are the barrier's sides. For every pair of sides the crossing
   distance through the freed cells is compared with today's ground distance: a portal is made
   if the regions are not connected at all (`connectsNewly`), the ground route is at least
   `shortcutRatio` times and `minShortcutSaving` cells longer, or a rock/depleted mineral group
   substantially obstructs an existing local corridor (`partial`). Contact search traverses
   exposed ramp cells to reach both landing regions, fixing previously missed ramp barriers.
   Removal never clears overlapping objects outside the group. An inventory retains every
   mineral/destructible even when it is not a portal. Ordinary resource lines are not classified
   as partial mineral walls. Rocks give `DESTRUCTIBLE`
   (`totalLife`), minerals `MINERAL_WALL` (`totalResources`).
4. **Expansions.** Mineral fields within `mineralLink` cluster (fields under a tenth of the
   fullest or under 50 are walls, not bases); geysers join the nearest cluster within
   `geyserLink`. Town hall centres within `searchRadius` must fit 5 × 5 on terrain-buildable
   cells outside the cluster's own resources and `NearResources` rings. Each candidate is scored by
   worker walking distance (distance fields from every resource) from the ring around the hall;
   unreachable resources disqualify it. The best candidate is then checked against the other
   blockers' cells: `AVAILABLE`, `BLOCKED_BY_DESTRUCTIBLE`, `BLOCKED_BY_MINERALS`,
   `BLOCKED_BY_NEUTRAL`, or `INVALID` when no candidate fits. A start location within 3 cells
   marks the main.
5. **Cliff portals.** SC2 uses cliff polylines and the shared `isCliffWalkerCrossing` minimap
   predicate: exactly one level and valid ground at 0.75 and 1 cell on both sides of the normal.
   Painted sub-cell pathing and placed blocking polygons are checked at each probe. Endpoints
   snap only to valid cells of the expected levels. Geometric landing points must belong to a
   same-level plateau with at
   least `minRegionArea` cells: mixed-height fringes cannot attach a tiny ledge to the upper
   component and impersonate the lower landing surface. Snapping searches up to `cliff.maxGap`
   cells (at least 2), and the resulting crossing is bounded by `maxGap + 2` endpoint cells.
   Generic grids without geometric candidates
   retain the eight-direction scan, limited to one level and disallowing painted gaps by default.
   Explicitly empty geometric candidates disable that fallback. Candidates are
   grouped by region pair, cut into pieces of `cliff.maxPortalWidth`, one representative each,
   kept apart by `cliff.minSpacing`. Valid geometry is retained even beside a ramp with a short
   ground detour; route costs, not topology extraction, decide whether to use it.
6. **Pre-drop portals.** Landing samples are region cells with clearance in
   `[landingClearance, landingClearance + 1)`, one per `sampleSpacing` bucket per region. A spatial
   hash finds sample pairs within `maxAirDistance`; one bounded distance field per sample decides
   whether the flight is useful: no ground route, or ground ≥ `minRatio` × air and ≥ `minSaving`
   longer. Pairs are bundled per region pair (both ends within `clusterRadius`), shortest flight
   first, at most `maxPerRegionPair`. Same-region shortcuts (a wall to walk around) are allowed.
7. **Accessibility.** From the regions holding start locations (or the largest region), the graph
   is searched per movement class; every region and expansion gets
   `{ ground, afterDestructibles, afterMineralWall, cliffWalker, preDrop }`.
8. **Chokes.** Connected roomy interiors (`choke.roomClearance`, `choke.minRoomArea`) expand
   into a watershed inside each region. Narrow seams between interiors become compressed choke
   centres, with approach points on either side. This includes diagonal corridors and excludes
   the three-cell vicinity of resource footprints to avoid resource-line artifacts. Width and
   room thresholds are configurable; this is a clearance heuristic, not an exhaustive medial axis.
9. **Strategic areas.** Physical components are not strategic nodes on their own: large open
   terrain is partitioned by multi-source geodesic Voronoi growth. Expansions seed protected
   neighbourhoods first; choke approaches and same-component cliff shortcuts supply additional
   seeds. Farthest-point coverage adds roomy centres until every cell is within
   `area.maxRadius` ground units (default 18) of its owner. `area.resourceRadius` (default 11,
   no larger than the maximum) prevents passage seeds from subdividing the base surroundings.
   No growth crosses physical components or forbidden cliff steps. Territories are connected,
   not Euclidean circles through walls. IDs `A1…`, `areaRuns` and `areaAt` describe them.
   Configurable preview inputs are `areaRadius` and `resourceAreaRadius`; the CLI accepts
   `--area-radius` and `--resource-radius`.
10. **Sub-cell movement refinement.** SC2 samples the existing cliff lattice, authored ramp
    gradients, sub-cell painted pathing and resolved footprint polygons at `groundCellSize`
    world units (default 0.25; adapter/preview configuration and CLI `--ground-cell-size`).
    Area ownership extends into sub-cell corridors without crossing cliff steps. Previously
    missing ground adjacencies receive normal links with a `CHOKE` vertex on the passage axis.
    Vertices need not be tile centres: free-run boundaries determine their midpoint.
    Existing ground/ramp paths are recalculated with clearance costs, cropped territory searches
    and cached fields shared by local approaches. Expansion placement coordinates remain exact;
    blocked expansions route to an accessible approach while their marker and blocker state stay
    unchanged. Portal/staging markers stay synchronized with graph endpoints. Endpoint links
    and diagonal steps are validated. Collinear samples are removed losslessly before output.
    Fine grids are preprocessing input only, never part of the runtime graph.

Cost: O(cells) for masks and components, one distance field per portal side, anchor and landing
sample (bounded where possible), plus one multi-source field per added area seed; no all-pairs
cell comparison. Quarter-cell sampling takes approximately 0.4–0.7 s normalization and 4–6 s
analysis on Amphion (machine/load dependent); expensive work remains outside gameplay.

## Graph

Nodes: `AREA` (strategic centre; resource areas reuse their `EXPANSION` node), `REGION`
(compatibility alias at an area's centre), `CHOKE`, `EXPANSION`, `RAMP` with two `STAGING_POINT`s, and two nodes per portal
(`DESTRUCTIBLE_PORTAL`, `MINERAL_PORTAL`, `CLIFF_PORTAL`, `PREDROP_PORTAL`: pickup / drop). Every
node uses original region membership where available; a sub-cell choke can stand between them.

Edges are undirected:

- `GROUND` between adjacent area representatives, plus local spokes from a representative to
  its transition endpoints. Searches stay inside the area or the two adjacent areas. There is
  no nearest-neighbour mesh around a base. Every legitimate area adjacency is retained, not
  only a minimum spanning tree; conditional passages remain conditional.
  A clearance penalty `1 + 2 / clearance` steers path search toward passage centres. Stored
  `path` polylines and physical `distance` describe that selected walking route; traversal width
  is the minimum clearance along it. Reconstruction follows the distance-field recurrence and
  never cuts blocked diagonal corners;
- `RAMP` staging point ↔ ramp ↔ staging point;
- `DESTRUCTIBLE`, `MINERAL_WALL`, `CLIFF`, `PREDROP` between a portal's two nodes.

Each edge carries `distance`, `entryPoint`, `exitPoint`, `blockerIds`, `destructionHP`,
`mineralAmount`, `requiredCapabilities` (`destroy`, `mine`, `cliff`, `transport`),
`traversalWidth` and `enabledCondition` (`always`, `capability`, `blockers`: usable with the
capability, and by everyone once the blockers are gone).

`areaConnections` contracts the local spokes and a crossing into one inter-area connection,
referencing its original `edgeIds`. The renderer uses these instead of drawing all internal
spokes. The complete graph retains staging and portal endpoints for routing and runtime state.

## Routing and runtime state

`findRoute(navigation, from, to, { capabilities, state, costs })` is Dijkstra over enabled edges.
Profiles: `NORMAL_GROUND` (none), `GROUND_CAN_DESTROY`, `WORKER_CAN_MINE`, `CLIFF_WALKER`,
`GROUND_WITH_TRANSPORT`. Cost in seconds:

```
cost = distance / speed
     + remainingHP × perHitPoint          (destructible)
     + remainingResources × perResource   (mineral wall)
     + transportFixed + air × transportPerCell   (pre-drop, instead of walking)
     + cliffJump                          (cliff)
     + risk[edgeType]
```

`findKRoutes` is Yen's algorithm. `findRouteAlternatives` returns route classes: the best plain
ground route, the best route each capability allows, and Yen alternatives, keeping a route only
when its set of special edges is new and it is shorter than every route kept before it. Every
route lists its classes, capabilities, blockers, HP and minerals. The analyzer only supplies
topology and costs; choosing is the AI's job.

Runtime state is separate: `NavigationState { removed, remaining }` with `removeBlockers` and
`setRemaining`. An edge whose blockers are all gone becomes free for everyone; partial damage or
mining lowers its cost. The graph itself never changes.

## Serialization

`serializeNavigation` writes deterministic JSON (ids and order follow row-major cell order and
object order, so the same map gives the same text): `regions`, `expansions`, `ramps`,
`destructiblePortals`, `mineralPortals`, `cliffPortals`, `predropPortals`, `nodes`, `edges`, and
`regionRuns` (`[firstCell, length, regionIndex]`, enough for `regionAt(x, y)` at runtime),
`areas`, `areaRuns` (same layout with area indices) and `areaConnections`.
`compactNavigation` gives flat number tables for Galaxy: node ids and positions, edge rows
`from, to, type, distance×10, hp, minerals, capabilityBits, firstBlocker, blockerCount`, and the
blocker id list.

## Debug view

`drawNavigation(overview, navigation, { layers, routes, spatial })` draws over
`renderMapOverview`; `navigationToPng` does both. Layers: `regions` (strategic area tint and centre),
`expansions` (5 × 5 square; cyan available, red blocked, grey invalid), `ramps` (magenta) and
`staging` (yellow), `chokes` (white), `destructible` (orange, including inventory markers),
`mineral` (blue), `cliff` (purple, dashed), `predrop` (green, dashed), `edges`, `nodes`.
Edges follow stored walking polylines and use the transition's colour. A single-class route uses
that class's colour; mixed routes use white ground segments with coloured special transitions.
Transport portals and incident edges are hidden by default; preview route planning also excludes
transport unless `layers.predrop` is explicitly enabled.

## Amphion

```
grid 176x176, blockers 212 (spatial 0.2–0.4 s, analysis about 1–3 s)
regions 15, strategic areas 51, area connections 122,
expansions 16, ramps 21/21 authored, chokes 2,
destructible 6 (including 2 partial), mineral 4, cliff 14, predrop 40 (hidden),
nodes 259, edges 326
```

All 16 bases are found at their town hall spots, both mains carry their start location, and the
three bases on the left can be reached by mining walls or destroying the previously missed
ramp barriers, but not by plain ground or cliff-only movement. All eight movement-blocking rocks
are marked in the inventory: four ramp barriers and two local widening passages become graph
portals; two other rocks remain inventory obstacles without a strategic crossing. Two build-only
destructibles remain in the inventory with empty movement footprints. Cliff crossing detection
now agrees with the minimap's one-step side-probe predicate. Threshold-dependent choke detection
finds two central diagonal necks. Example legacy portal records below illustrate the format;
current IDs/distances are supplied by the generated JSON.

Current debug artifacts: `reports/tools/sc2-map-nav/amphion-navigation-subcell.json` and
`.cache/world-renders/amphion-nav-subcell.png`. The CLI's `--validate` checks that every area is
connected, every area in a physical region is ground-reachable from its first representative,
and every stored ground/ramp path is walkable without an ordinary cliff jump. The two newly
retained symmetric central cliff crossings connect the actual upper and lower components,
not the tiny fringe ledges. Conditional inter-area approaches use their crossing's colour;
short dashed crossings retain ink at both endpoints.

```json
{"id":"D1","kind":"destructible","blockerIds":["375330839"],"regionA":"R7","regionB":"R10",
 "entryA":[82.5,75.5],"entryB":[87.5,81.5],"crossing":5.24,"groundDistance":50.8,
 "connectsNewly":false,"width":9,"totalLife":2000}
{"id":"RAMP1","center":[56.5,41.5],"width":3,"direction":[-0.71,-0.71],"lowerRegion":"R3",
 "upperRegion":"R2","lowerEntry":[59.5,42.5],"upperEntry":[54.5,38.5],
 "lowerStagingPoint":[61.5,44.5],"upperStagingPoint":[52.5,36.5]}
{"id":"P1","regionA":"R1","regionB":"R1","pickupA":[118.5,20.5],"dropB":[104.5,26.5],
 "airDistance":15.23,"groundDistance":31.56,"groundShortcutRatio":2.07,"landingClearance":2}
```

## Known limitations

- Region/area masks and placement use the original cell grid; movement may use finer sampling.
  Sub-cell corridors connect components by edges without relabelling original region IDs.
  Widths/diagonal squeezes remain approximations, not SC2 engine collision queries;
  unit-specific radii still need validation.
- Fine movement excludes level A space, consistent with the minimap cliff predicate;
  water depth is not read.
- Cliff portals model a one-level crossing; unit-specific rules (Reaper vs Colossus) still need
  capability-specific validation. Geometric probes are sub-cell, but their endpoints and ground
  routes are refined when `groundSampling` is available.
- Choke detection is threshold-dependent; small rooms and resource-adjacent seams are excluded.
- Pre-drop sampling can miss very small landing areas below `landingClearance`.
- Route alternatives are distinct by the special edges they use, not by geometric corridor.
- Hub-based paths intentionally compress local movement; distances can exceed a full-resolution
  cell-optimal path. Area radii and resource protection are configurable geometric heuristics.
- Placement ignores creep, power and other race rules; only the town hall footprint and
  `NearResources` are checked.
