/**
 * Route planning over a `MapNavigation` graph, with runtime blocker state kept apart from the
 * static topology: destroying rocks or mining out a wall changes edge state and cost, never the
 * graph. The analyzer supplies topology and costs; which route to take is the caller's decision.
 */

import type { Capability, MapNavigation, NavigationEdge, NavigationEdgeType } from './analyze.js'

// ---------------------------------------------------------------------------------------------
// Runtime state
// ---------------------------------------------------------------------------------------------

/** Blocker state during a game: what is gone and how much is left in the fields. */
export interface NavigationState {
  readonly removed: ReadonlySet<string>
  /** Remaining resources by blocker id, when they differ from the analyzed amount. */
  readonly remaining: ReadonlyMap<string, number>
}

export function createNavigationState(): NavigationState {
  return { removed: new Set(), remaining: new Map() }
}

/** A new state with blockers destroyed (or mined out). */
export function removeBlockers(state: NavigationState, ids: readonly string[]): NavigationState {
  return { removed: new Set([...state.removed, ...ids]), remaining: state.remaining }
}

/** A new state with a field's remaining amount; zero removes it. */
export function setRemaining(state: NavigationState, id: string, amount: number): NavigationState {
  const remaining = new Map(state.remaining)
  remaining.set(id, amount)
  return amount <= 0 ? removeBlockers({ ...state, remaining }, [id]) : { ...state, remaining }
}

// ---------------------------------------------------------------------------------------------
// Profiles and costs
// ---------------------------------------------------------------------------------------------

export type MovementProfile =
  | 'NORMAL_GROUND'
  | 'GROUND_CAN_DESTROY'
  | 'WORKER_CAN_MINE'
  | 'CLIFF_WALKER'
  | 'GROUND_WITH_TRANSPORT'

export const PROFILE_CAPABILITIES: Readonly<Record<MovementProfile, readonly Capability[]>> = {
  NORMAL_GROUND: [],
  GROUND_CAN_DESTROY: ['destroy'],
  WORKER_CAN_MINE: ['mine'],
  CLIFF_WALKER: ['cliff'],
  GROUND_WITH_TRANSPORT: ['transport'],
}

export interface RouteCosts {
  /** Cells per second of ground movement. */
  readonly speed: number
  /** Seconds per hit point to destroy. */
  readonly perHitPoint: number
  /** Seconds per resource unit to mine out. */
  readonly perResource: number
  /** Seconds to load, fly and unload, plus seconds per cell of flight. */
  readonly transportFixed: number
  readonly transportPerCell: number
  /** Seconds per cliff jump. */
  readonly cliffJump: number
  /** Extra seconds by edge type, e.g. for risk. */
  readonly risk: Partial<Readonly<Record<NavigationEdgeType, number>>>
}

export const DEFAULT_ROUTE_COSTS: RouteCosts = {
  speed: 3,
  perHitPoint: 0.005,
  perResource: 0.05,
  transportFixed: 8,
  transportPerCell: 0.25,
  cliffJump: 1,
  risk: {},
}

export interface EdgeTraversal {
  readonly enabled: boolean
  /** Seconds. */
  readonly cost: number
  /** The blockers still standing on this edge. */
  readonly blocking: readonly string[]
  readonly remainingHP: number
  readonly remainingResources: number
}

const resourceCache = new WeakMap<MapNavigation, ReadonlyMap<string, number>>()

/** Each wall field's analyzed amount (a wall's total shared evenly when fields are not known apart). */
function analyzedResources(navigation: MapNavigation): ReadonlyMap<string, number> {
  let cached = resourceCache.get(navigation)
  if (cached === undefined) {
    cached = new Map(
      navigation.mineralPortals.flatMap(portal =>
        portal.blockerIds.map(
          id => [id, (portal.totalResources ?? 0) / portal.blockerIds.length] as const,
        ),
      ),
    )
    resourceCache.set(navigation, cached)
  }
  return cached
}

/** Whether and at what cost an edge can be used now by a unit with `capabilities`. */
export function edgeTraversal(
  navigation: MapNavigation,
  edge: NavigationEdge,
  capabilities: readonly Capability[],
  state: NavigationState = createNavigationState(),
  costs: RouteCosts = DEFAULT_ROUTE_COSTS,
): EdgeTraversal {
  const blocking = edge.blockerIds.filter(id => !state.removed.has(id))
  const lifeShare = edge.blockerIds.length === 0 ? 0 : blocking.length / edge.blockerIds.length
  const remainingHP = Math.round(edge.destructionHP * lifeShare)
  const analyzed = analyzedResources(navigation)
  const remainingResources =
    edge.type === 'MINERAL_WALL'
      ? blocking.reduce((sum, id) => sum + (state.remaining.get(id) ?? analyzed.get(id) ?? 0), 0)
      : 0
  const risk = costs.risk[edge.type] ?? 0
  const walk = edge.distance / costs.speed
  const cleared = edge.enabledCondition === 'blockers' && blocking.length === 0
  if (cleared)
    return { enabled: true, cost: walk + risk, blocking, remainingHP: 0, remainingResources: 0 }
  const allowed = edge.requiredCapabilities.every(capability => capabilities.includes(capability))
  if (!allowed) return { enabled: false, cost: Infinity, blocking, remainingHP, remainingResources }
  let cost = walk + risk
  if (edge.type === 'DESTRUCTIBLE') cost += remainingHP * costs.perHitPoint
  if (edge.type === 'MINERAL_WALL') cost += remainingResources * costs.perResource
  if (edge.type === 'PREDROP')
    cost = costs.transportFixed + edge.distance * costs.transportPerCell + risk
  if (edge.type === 'CLIFF') cost += costs.cliffJump
  return { enabled: true, cost, blocking, remainingHP, remainingResources }
}

// ---------------------------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------------------------

export interface RouteStep {
  readonly edge: NavigationEdge
  /** The node the step starts from (edges are undirected). */
  readonly from: string
  readonly to: string
  readonly cost: number
}

export interface Route {
  readonly nodes: readonly string[]
  readonly steps: readonly RouteStep[]
  readonly cost: number
  readonly distance: number
  /** The non-ground edge types used, in order: the route's class. */
  readonly classes: readonly NavigationEdgeType[]
  readonly requiredCapabilities: readonly Capability[]
  readonly blockerIds: readonly string[]
  readonly destructionHP: number
  readonly mineralAmount: number
}

export interface RouteQuery {
  readonly capabilities?: readonly Capability[]
  readonly state?: NavigationState
  readonly costs?: RouteCosts
}

interface Adjacency {
  readonly byNode: ReadonlyMap<string, readonly NavigationEdge[]>
}

const adjacencyCache = new WeakMap<MapNavigation, Adjacency>()

function adjacencyOf(navigation: MapNavigation): Adjacency {
  let cached = adjacencyCache.get(navigation)
  if (cached === undefined) {
    const byNode = new Map<string, NavigationEdge[]>()
    for (const edge of navigation.edges)
      for (const end of [edge.from, edge.to]) {
        const list = byNode.get(end)
        if (list === undefined) byNode.set(end, [edge])
        else list.push(edge)
      }
    cached = { byNode }
    adjacencyCache.set(navigation, cached)
  }
  return cached
}

function buildRoute(
  navigation: MapNavigation,
  nodes: string[],
  steps: RouteStep[],
  state: NavigationState,
): Route {
  const special = steps.filter(step => step.edge.type !== 'GROUND' && step.edge.type !== 'RAMP')
  const active = special.filter(
    step =>
      !(
        step.edge.enabledCondition === 'blockers' &&
        step.edge.blockerIds.every(id => state.removed.has(id))
      ),
  )
  return {
    nodes,
    steps,
    cost: steps.reduce((sum, step) => sum + step.cost, 0),
    distance: Math.round(steps.reduce((sum, step) => sum + step.edge.distance, 0) * 100) / 100,
    classes: active.map(step => step.edge.type),
    requiredCapabilities: [
      ...new Set(active.flatMap(step => step.edge.requiredCapabilities)),
    ].sort(),
    blockerIds: active.flatMap(step => step.edge.blockerIds.filter(id => !state.removed.has(id))),
    destructionHP: active
      .filter(step => step.edge.type === 'DESTRUCTIBLE')
      .reduce(
        (sum, step) => sum + edgeTraversal(navigation, step.edge, ['destroy'], state).remainingHP,
        0,
      ),
    mineralAmount: active
      .filter(step => step.edge.type === 'MINERAL_WALL')
      .reduce(
        (sum, step) =>
          sum + edgeTraversal(navigation, step.edge, ['mine'], state).remainingResources,
        0,
      ),
  }
}

/**
 * Dijkstra from `from` to `to` over the enabled edges. `bannedEdges` / `bannedNodes` support
 * Yen's algorithm.
 */
export function findRoute(
  navigation: MapNavigation,
  from: string,
  to: string,
  query: RouteQuery = {},
  bannedEdges: ReadonlySet<string> = new Set(),
  bannedNodes: ReadonlySet<string> = new Set(),
): Route | undefined {
  const capabilities = query.capabilities ?? []
  const state = query.state ?? createNavigationState()
  const costs = query.costs ?? DEFAULT_ROUTE_COSTS
  const { byNode } = adjacencyOf(navigation)
  const best = new Map<string, number>([[from, 0]])
  const previous = new Map<string, RouteStep>()
  const open: [number, number, string][] = [[0, 0, from]]
  let counter = 0
  const done = new Set<string>()
  while (open.length > 0) {
    open.sort((a, b) => a[0] - b[0] || a[1] - b[1])
    const [cost, , node] = open.shift()!
    if (done.has(node)) continue
    done.add(node)
    if (node === to) break
    for (const edge of byNode.get(node) ?? []) {
      if (bannedEdges.has(edge.id)) continue
      const next = edge.from === node ? edge.to : edge.from
      if (bannedNodes.has(next) || done.has(next)) continue
      const traversal = edgeTraversal(navigation, edge, capabilities, state, costs)
      if (!traversal.enabled) continue
      const candidate = cost + traversal.cost
      if (candidate < (best.get(next) ?? Infinity)) {
        best.set(next, candidate)
        previous.set(next, { edge, from: node, to: next, cost: traversal.cost })
        open.push([candidate, ++counter, next])
      }
    }
  }
  if (!done.has(to)) return undefined
  const steps: RouteStep[] = []
  for (let node = to; node !== from;) {
    const step = previous.get(node)!
    steps.unshift(step)
    node = step.from
  }
  return buildRoute(navigation, [from, ...steps.map(step => step.to)], steps, state)
}

/** Yen's K shortest loopless routes. */
export function findKRoutes(
  navigation: MapNavigation,
  from: string,
  to: string,
  k: number,
  query: RouteQuery = {},
): Route[] {
  const first = findRoute(navigation, from, to, query)
  if (first === undefined) return []
  const found: Route[] = [first]
  const candidates: Route[] = []
  const key = (route: Route) => route.steps.map(step => step.edge.id).join(',')
  const known = new Set([key(first)])
  for (let n = 1; n < k; n += 1) {
    const last = found[n - 1]!
    for (let i = 0; i < last.steps.length; i += 1) {
      const spur = last.nodes[i]!
      const rootSteps = last.steps.slice(0, i)
      const bannedEdges = new Set<string>()
      for (const route of found)
        if (
          route.steps.slice(0, i).every((step, index) => step.edge.id === rootSteps[index]!.edge.id)
        )
          bannedEdges.add(route.steps[i]?.edge.id ?? '')
      const bannedNodes = new Set(last.nodes.slice(0, i))
      const tail = findRoute(navigation, spur, to, query, bannedEdges, bannedNodes)
      if (tail === undefined) continue
      const steps = [...rootSteps, ...tail.steps]
      const route = buildRoute(
        navigation,
        [...last.nodes.slice(0, i), ...tail.nodes],
        steps,
        query.state ?? createNavigationState(),
      )
      const id = key(route)
      if (known.has(id)) continue
      known.add(id)
      candidates.push(route)
    }
    if (candidates.length === 0) break
    candidates.sort((a, b) => a.cost - b.cost || key(a).localeCompare(key(b)))
    found.push(candidates.shift()!)
  }
  return found
}

const CLASS_CAPABILITIES: readonly (readonly Capability[])[] = [
  [],
  ['destroy'],
  ['mine'],
  ['cliff'],
  ['transport'],
  ['destroy', 'mine', 'cliff', 'transport'],
]

/**
 * Alternative route classes between two nodes: the best plain ground route, then the best route
 * each extra capability allows, then Yen alternatives with every capability. A route is kept only
 * when its class (the blockers, cliffs and flights it uses) is new and, unless it is the plain
 * ground route, it is shorter than every route kept before it.
 */
export function findRouteAlternatives(
  navigation: MapNavigation,
  from: string,
  to: string,
  query: RouteQuery & { readonly alternatives?: number } = {},
): Route[] {
  const allowed = query.capabilities
  const sets = CLASS_CAPABILITIES.filter(
    set => allowed === undefined || set.every(item => allowed.includes(item)),
  )
  const all = allowed ?? CLASS_CAPABILITIES[CLASS_CAPABILITIES.length - 1]!
  const found = [
    ...sets.map(capabilities => findRoute(navigation, from, to, { ...query, capabilities })),
    ...findKRoutes(navigation, from, to, query.alternatives ?? 6, { ...query, capabilities: all }),
  ].filter((route): route is Route => route !== undefined)
  const signature = (route: Route) =>
    route.steps
      .filter(
        step =>
          route.classes.includes(step.edge.type) &&
          step.edge.type !== 'GROUND' &&
          step.edge.type !== 'RAMP',
      )
      .map(step => step.edge.id)
      .join(',')
  const kept: Route[] = []
  const seen = new Set<string>()
  for (const route of found) {
    const id = signature(route)
    if (seen.has(id)) continue
    const shortest = Math.min(...kept.map(item => item.distance))
    if (kept.length > 0 && id !== '' && route.distance >= shortest) continue
    seen.add(id)
    kept.push(route)
  }
  return kept.sort((a, b) => a.cost - b.cost)
}

// ---------------------------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------------------------

/** Deterministic, human-readable JSON: stable key order as built, two-space indent. */
export function serializeNavigation(navigation: MapNavigation): string {
  return `${JSON.stringify(navigation, null, 2)}\n`
}

export function parseNavigation(text: string): MapNavigation {
  const value = JSON.parse(text) as MapNavigation
  if (value.version !== 1)
    throw new RangeError(`unsupported navigation version ${String(value.version)}`)
  return value
}

/**
 * A compact form for runtime code (Galaxy): node and edge tables as flat numbers, ids replaced
 * by indices. Edge rows are `from, to, type, distance×10, hp, minerals, capabilityBits,
 * firstBlocker, blockerCount`; blocker ids are listed once.
 */
export function compactNavigation(navigation: MapNavigation) {
  const nodeIndex = new Map(navigation.nodes.map((node, index) => [node.id, index]))
  const types: readonly NavigationEdgeType[] = [
    'GROUND',
    'RAMP',
    'DESTRUCTIBLE',
    'MINERAL_WALL',
    'CLIFF',
    'PREDROP',
  ]
  const capabilityBits: Readonly<Record<Capability, number>> = {
    destroy: 1,
    mine: 2,
    cliff: 4,
    transport: 8,
  }
  const blockers: string[] = []
  const edges: number[] = []
  for (const edge of navigation.edges) {
    edges.push(
      nodeIndex.get(edge.from)!,
      nodeIndex.get(edge.to)!,
      types.indexOf(edge.type),
      Math.round(edge.distance * 10),
      edge.destructionHP,
      edge.mineralAmount,
      edge.requiredCapabilities.reduce((bits, item) => bits | capabilityBits[item], 0),
      blockers.length,
      edge.blockerIds.length,
    )
    blockers.push(...edge.blockerIds)
  }
  return {
    nodeIds: navigation.nodes.map(node => node.id),
    nodeXY: navigation.nodes.flatMap(node => [
      Math.round(node.position[0] * 10),
      Math.round(node.position[1] * 10),
    ]),
    edgeTypes: types,
    edges,
    blockers,
  }
}
