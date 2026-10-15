import { AVAILABLE_BUILDS } from './protocols/builds.js'
import { decodeVersioned } from './versioned.js'
import { decodeGameEvents, decodeMessageEvents, decodeReplayInitData } from './streams.js'

const cache = new Map()
export { AVAILABLE_BUILDS }
export * from './versioned.js'
export * from './bitpacked.js'
export * from './streams.js'
export * from './tracker.js'

export function resolveProtocolBuild(requestedBuild, options = {}) {
  if (!Number.isSafeInteger(requestedBuild) || requestedBuild <= 0) throw new RangeError('s2protocol build must be a positive safe integer')
  if (AVAILABLE_BUILDS.includes(requestedBuild)) {
    return Object.freeze({ requestedBuild, selectedBuild: requestedBuild, exact: true, diagnostics: Object.freeze([]) })
  }
  const fallback = options.fallback ?? 'none'
  if (fallback === 'none') throw new RangeError(`s2protocol build ${requestedBuild} is not bundled`)
  if (fallback !== 'nearest-lower') throw new TypeError(`unknown s2protocol fallback policy: ${fallback}`)
  const selectedBuild = [...AVAILABLE_BUILDS].reverse().find(build => build <= requestedBuild)
  if (selectedBuild === undefined) throw new RangeError(`s2protocol has no build at or below ${requestedBuild}`)
  return Object.freeze({
    requestedBuild,
    selectedBuild,
    exact: false,
    diagnostics: Object.freeze([Object.freeze({
      code: 'blizzard/s2protocol-build-fallback',
      severity: 'warning',
      message: `Protocol build ${selectedBuild} selected for replay build ${requestedBuild}; layouts may differ.`,
    })]),
  })
}

export async function loadProtocol(requestedBuild, options = {}) {
  options.signal?.throwIfAborted()
  const resolution = resolveProtocolBuild(requestedBuild, options)
  let protocol = cache.get(resolution.selectedBuild)
  if (protocol === undefined) {
    protocol = (await import(`./protocols/data/protocol${resolution.selectedBuild}.js`)).default
    cache.set(resolution.selectedBuild, protocol)
  }
  options.signal?.throwIfAborted()
  return Object.freeze({ protocol, resolution })
}

export const abiVersion = 1
export const provides = Object.freeze(['common.blizzard/s2protocol'])

export function createProvider(selection) {
  if (selection?.contract !== 'common.blizzard/s2protocol' || selection.major !== 1) {
    throw new TypeError(`unsupported s2protocol selection ${selection?.contract}@${selection?.major}`)
  }
  return Object.freeze({
    value: Object.freeze({
      contract: 'common.blizzard/s2protocol',
      listBuilds: () => AVAILABLE_BUILDS,
      resolve: resolveProtocolBuild,
      load: loadProtocol,
      decodeVersioned,
      decodeBitPacked: async (bytes, request = {}) => {
        const { protocol, resolution } = await loadProtocol(request.build, request)
        const value = request.stream === 'game'
          ? decodeGameEvents(bytes, protocol, request)
          : request.stream === 'message'
            ? decodeMessageEvents(bytes, protocol, request)
            : request.stream === 'init'
              ? decodeReplayInitData(bytes, protocol, request)
              : (() => { throw new TypeError(`unsupported bitpacked replay stream: ${request.stream}`) })()
        return Object.freeze({ resolution, value })
      },
    }),
    release: async () => undefined,
  })
}
