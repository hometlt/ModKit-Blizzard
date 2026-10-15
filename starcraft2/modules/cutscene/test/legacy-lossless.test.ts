import { expect, it } from 'vitest'
import { decodeCutsceneText } from '../codecs/cutscene/src/decode.js'
import { encodeCutsceneText } from '../codecs/cutscene/src/encode.js'
it('keeps legacy ActorState BOM, boolean spelling, unknown attributes and layout byte for byte', () => {
  const text='\ufeff<?xml version="1.0"?>\r\n<ActorState future="opaque">\r\n\t<ActorNode name="Cam_Export"  model="Assets/Camera.m3" enabled="true" futureAttr="&amp;kept">\r\n <AnimLayerNode><AnimBlock anim="Dialogue 04" time="1000" duration="2000"/></AnimLayerNode>\r\n\t</ActorNode><ActorNode name="Hidden" enabled="false"/>\r\n</ActorState>\r\n'
  const decoded=decodeCutsceneText(text)
  expect(encodeCutsceneText(decoded)).toBe(text)
  expect(new TextEncoder().encode(encodeCutsceneText(decoded))).toEqual(new TextEncoder().encode(text))
})
