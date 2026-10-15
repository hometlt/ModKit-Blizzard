/**
 * WC3 native material-header admission for MDX/MDL writers and UVM residual capture, versions900+.
 * KMTE keys and the authored static header are independent records; this validates only the latter,
 * without sampling or interpreting its playback/default semantics. Finite exact float32 carriers
 * excluding negative zero survive native/JSON reconstruction; invalid/conflicting carriers refuse.
 * An absent legacy carrier retains writer compatibility default1, never a recovered authored value.
 * MDL cannot emit a non-default header beside KMTE until native grammar is qualified. No I/O,
 * general model parser, renderer or shared SDK/UV extension is provided. The caller owns model bounds;
 * cancellation is checked while visiting its parsed material records. See MDX-PORT-PROVENANCE.json
 * and contributions/codec-war3-mdx.json for the native-preservation boundary.
 */

/** Keep unsupported native fallback facts out of byte writes and lossy JSON residual snapshots. */
export function admitWar3MaterialHeaders(native: unknown, encoding: 'mdx' | 'mdl', signal?: AbortSignal): void {
  if (typeof native !== 'object' || native === null) throw new TypeError('native material headers require a model record')
  const model = native as Readonly<Record<string, unknown>>
  if (!Array.isArray(model['Materials'])) return
  for (const material of model['Materials']) {
    signal?.throwIfAborted()
    if (typeof material !== 'object' || material === null || !Array.isArray(material.Layers)) continue
    for (const layer of material.Layers) {
      signal?.throwIfAborted()
      if (typeof layer !== 'object' || layer === null) continue
      const fallback: unknown = layer.EmissiveGainFallback
      if (fallback === undefined) continue
      if (typeof model['Version'] !== 'number' || model['Version'] < 900)
        throw new TypeError('EmissiveGainFallback requires native version900 or later')
      if (typeof fallback !== 'number' || !Number.isFinite(fallback) || Math.fround(fallback) !== fallback || Object.is(fallback, -0))
        throw new TypeError('EmissiveGainFallback must be a finite exact float32 number without negative zero')
      if (layer.EmissiveGain === undefined || layer.EmissiveGain === null)
        throw new TypeError('EmissiveGainFallback requires a native EmissiveGain value or KMTE track')
      if (typeof layer.EmissiveGain === 'number' && layer.EmissiveGain !== fallback)
        throw new TypeError('EmissiveGainFallback conflicts with the static EmissiveGain value')
      if (encoding === 'mdl' && typeof layer.EmissiveGain !== 'number' && fallback !== 1)
        throw new TypeError('MDL cannot preserve a non-default static EmissiveGain header alongside KMTE; write MDX instead')
    }
  }
}
