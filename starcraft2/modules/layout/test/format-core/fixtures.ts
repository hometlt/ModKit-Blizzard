import { createMemoryAssetSource, type AssetSource } from '@modkit/codec-kit/legacy/assets'

export const LAYOUT_XML = `<?xml version="1.0" encoding="utf-8" standalone="yes"?>
<Desc>
  <Include path="UI/Layout/Shared.SC2Layout"/>
  <Constant name="Gap" val="5"/>
  <Frame type="Frame" name="Root">
    <Anchor relative="$parent"/>
    <Frame type="Image" name="Icon" template="Shared/IconTemplate">
      <Texture val="@@UI/TestIcon"/>
      <Width val="#Gap"/>
    </Frame>
    <Frame type="Label" name="Title">
      <Text val="@UI/TestTitle"/>
    </Frame>
  </Frame>
</Desc>
`

export const LAYOUT_BYTES = new TextEncoder().encode(LAYOUT_XML)

export function fixtureSource(
  bytes: Uint8Array = LAYOUT_BYTES,
  path = 'UI/Layout/Test.SC2Layout',
): AssetSource {
  return createMemoryAssetSource(bytes, {
    path,
    kind: 'archive-entry',
    context: {
      gameId: 'starcraft-2',
      parentArtifactIds: ['sc2-mod'],
    },
  })
}
