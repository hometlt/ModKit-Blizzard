/**
 * The bank's language services must reach an editor, not merely exist.
 *
 * VS Code does not consume a provider because the provider is written; it consumes the routes the
 * host derives from the inventory (`languageProviderRoutes`), and registers its language features
 * against exactly those. A provider with no contribution is therefore invisible there no matter how
 * complete it is — which is the state the bank was in until this contribution existed. This test
 * asserts the route, so deleting or misdeclaring the contribution fails here rather than silently
 * turning the feature off in the editor.
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { buildInventory, createHostContributionContractRegistry } from '@modkit/host'
import { languageProviderRoutes } from '@modkit/host'
import { loadExtensionDirectory } from '@modkit/host/node'

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url))
const repository = JSON.parse(
  await readFile(new URL('../modkit.repository.json', import.meta.url), 'utf8'),
)

async function inventory() {
  const inputs = await Promise.all(
    repository.extensions.map(async extension => ({
      ...(await loadExtensionDirectory(join(repositoryRoot, extension.path))),
      execution: { origin: 'bundled', allowTrustedInProcess: true },
    })),
  )
  return buildInventory(inputs, createHostContributionContractRegistry())
}

test('the bank language provider is routed to editors alongside the other SC2 languages', async () => {
  const routes = languageProviderRoutes(await inventory())
  const byLanguage = new Map(routes.map(route => [route.languageId, route]))
  for (const languageId of ['sc2-bank', 'sc2-data', 'sc2-layout', 'sc2-strings', 'sc2-triggers', 'galaxy']) {
    assert.ok(byLanguage.has(languageId), `no language route for ${languageId}`)
  }
  /*
   * VS Code builds its file-glob document filter from this value, so it has to be the one the host
   * actually holds rather than the one the contribution wrote: the host lower-cases it, which is
   * why this reads `sc2bank` and not the format's usual `SC2Bank` spelling.
   */
  assert.equal(byLanguage.get('sc2-bank').extension, 'sc2bank')
})
