import { defineLinkedExtension } from '@modkit/host'

import providerManifest from '../modules/game/providers/installation/provider.json' with { type: 'json' }
import dataManifest from '../modules/data/providers/catalog-analysis/provider.json' with { type: 'json' }
import resolvedDataManifest from '../modules/data/providers/resolved-data/provider.json' with { type: 'json' }
import mapManifest from '../modules/map/providers/semantic/provider.json' with { type: 'json' }
import mapPreviewManifest from '../modules/map/providers/preview/provider.json' with { type: 'json' }
import launchManifest from '../modules/game/providers/launch/provider.json' with { type: 'json' }
import packageJson from '../package.json' with { type: 'json' }
import * as provider from '../modules/game/providers/installation/provider.js'
import * as dataProvider from '../modules/data/providers/catalog-analysis/runtime.js'
import * as resolvedDataProvider from '../modules/data/providers/resolved-data/runtime.js'
import * as mapProvider from '../modules/map/providers/semantic/runtime.js'
import * as mapPreviewProvider from '../modules/map/providers/preview/runtime.js'
import * as launchProvider from '../modules/game/providers/launch/runtime.js'

export const starcraft2Game = defineLinkedExtension({
  source: 'linked:extensions/blizzard/starcraft2-game',
  packageJson: {
    ...packageJson,
    name: '@modkit/blizzard-starcraft2-game',
    modkit: { ...packageJson.modkit, id: 'starcraft2-game' },
  },
  contributions: [
    { path: 'modules/game/providers/installation/provider.json', manifest: providerManifest },
    { path: 'modules/data/providers/catalog-analysis/provider.json', manifest: dataManifest },
    { path: 'modules/data/providers/resolved-data/provider.json', manifest: resolvedDataManifest },
    { path: 'modules/map/providers/semantic/provider.json', manifest: mapManifest },
    { path: 'modules/map/providers/preview/provider.json', manifest: mapPreviewManifest },
    { path: 'modules/game/providers/launch/provider.json', manifest: launchManifest },
  ],
  modules: {
    './modules/game/providers/installation/provider.js': provider,
    './modules/data/providers/catalog-analysis/runtime.js': dataProvider,
    './modules/data/providers/resolved-data/runtime.js': resolvedDataProvider,
    './modules/map/providers/semantic/runtime.js': mapProvider,
    './modules/map/providers/preview/runtime.js': mapPreviewProvider,
    './modules/game/providers/launch/runtime.js': launchProvider,
  },
})
