export * from '../../../modkit-core/packages/codec-kit/src/legacy/core/index.js'
export {
  Emitter,
  isPromise,
  logger,
} from '../../../modkit-core/packages/codec-kit/src/legacy-sc2-support.js'
export type {
  Disposable,
  Event,
  LegacyVirtualFileSystem,
  VirtualFileSystem,
} from '../../../modkit-core/packages/codec-kit/src/legacy-sc2-support.js'

export interface LogItOptions {
  readonly level?: string
  readonly message?: string
  readonly profiling?: boolean
  readonly argsDump?: ((...args: any[]) => unknown) | boolean
  readonly resDump?: ((result: any) => unknown) | boolean
  readonly scopeDump?: (scope: any) => unknown
}

export declare function logIt(options?: LogItOptions): MethodDecorator
