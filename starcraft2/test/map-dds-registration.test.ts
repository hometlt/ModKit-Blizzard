import { expect, it } from 'vitest'
import { buildInventory, createHostContributionContractRegistry } from '@modkit/host'
import { loadExtensionDirectory } from '@modkit/host/node'

it('keeps the DDS codec eligible for map terrain textures', async () => {
  const input = await loadExtensionDirectory(new URL('../../../modkit-core/extensions/images/', import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/u, ''))
  const inventory = await buildInventory([{ ...input, execution: { origin: 'bundled', allowTrustedInProcess: true } }], createHostContributionContractRegistry())
  const dds = inventory.extensions.flatMap(item => item.contributions).find(item => item.manifest?.id === 'modkit/dds')
  console.log(JSON.stringify({ eligible: dds?.activationEligible, representations: dds?.manifest?.spec?.representations, diagnostics: dds?.diagnostics }))
  expect(dds?.activationEligible).toBe(true)
})
