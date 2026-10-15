import { M3Model } from '../../../dist/m3/native/model.js'

/** Narrow runtime bridge; the facade operates on the already parsed native sections. */
export function createM3NativeFacade(sections) {
  return new M3Model(sections)
}
