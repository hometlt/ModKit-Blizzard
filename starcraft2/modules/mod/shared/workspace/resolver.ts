import { getLogger } from '@modkit/codec-kit'

const resolveLog = getLogger(['blizzard', 'starcraft2', 'mod', 'resolve'])

/** One source probed while resolving a dependency name. */
export interface ResolveProbe {
  readonly dependency: string
  readonly source: string
  readonly path: string | undefined
  readonly hit: boolean
  readonly ms: number
}

export type ProbeSink = (probe: ResolveProbe) => void

/** A named source in an ordered dependency workspace. */
export interface ResolverSource {
  readonly label: string
  resolve(name: string): Promise<string | undefined>
}

export interface ModResolverConfig {
  /** Sources are queried in order; the first hit wins. */
  readonly sources?: readonly ResolverSource[]
}

/**
 * Game-neutral dependency resolver over an ordered collection of mounted sources.
 *
 * Package naming, installation paths, and remote-depot behavior belong to semantic/game codecs;
 * those codecs contribute {@link ResolverSource} instances instead of teaching this class about
 * their formats.
 */
export class ModResolver {
  private readonly sources: readonly ResolverSource[]

  constructor(config: ModResolverConfig = {}) {
    this.sources = config.sources ?? []
  }

  async resolve(name: string, onProbe?: ProbeSink): Promise<string | undefined> {
    for (const source of this.sources) {
      const started = Date.now()
      const path = await source.resolve(name)
      const probe: ResolveProbe = {
        dependency: name,
        source: source.label,
        path,
        hit: path !== undefined,
        ms: Date.now() - started,
      }
      resolveLog.debug(`${probe.hit ? 'hit ' : 'miss'} ${probe.source} -> '${name}'`, {
        ...probe,
      })
      onProbe?.(probe)
      if (path !== undefined) return path
    }
    return undefined
  }
}
