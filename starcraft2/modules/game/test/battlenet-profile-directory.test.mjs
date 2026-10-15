import assert from 'node:assert/strict'
import test from 'node:test'
import { createProfileDirectory, profileKey } from '../../../dist/modules/game/battlenet/profiles/profile-directory.js'

function api({ tokenStatus = 200, expiresIn = 3600 } = {}) {
  const calls = []
  let clock = 1000
  const fetch = async (url, init) => {
    calls.push({ url: String(url), auth: init.headers.authorization })
    if (String(url) === 'https://oauth.battle.net/token') {
      assert.equal(init.method, 'POST')
      assert.equal(init.body, 'grant_type=client_credentials')
      return new Response(JSON.stringify({ access_token: `t${calls.length}`, expires_in: expiresIn }), { status: tokenStatus })
    }
    const id = String(url).match(/profile\/\d+\/\d+\/(\d+)/)[1]
    if (id === '404') return new Response('{}', { status: 404 })
    if (id === '500') return new Response('{}', { status: 500 })
    return new Response(JSON.stringify({ name: `Player${id}`, profileUrl: `https://starcraft2.blizzard.com/profile/2/1/${id}`,
      avatarUrl: id === '66' ? 'javascript:alert(1)' : `https://static.starcraft2.com/portraits/${id}.jpg` }))
  }
  return { calls, fetch, now: () => clock, advance: seconds => { clock += seconds } }
}

const signal = new AbortController().signal
const eu = id => ({ region: 2, realm: 1, id })

test('profiles resolve to name and portrait through one client token, and are kept', async () => {
  const fake = api()
  const directory = createProfileDirectory({ clientId: 'id', clientSecret: 'secret' }, fake)
  const found = await directory.describe([eu('77'), eu('404'), { region: 1, realm: 2, id: '5' }], signal)
  assert.deepEqual(found.get(profileKey(eu('77'))), { name: 'Player77', avatarUrl: 'https://static.starcraft2.com/portraits/77.jpg',
    profileUrl: 'https://starcraft2.blizzard.com/profile/2/1/77' })
  assert.equal(found.get(profileKey(eu('404'))), null)
  assert.equal(fake.calls.filter(call => call.url.endsWith('/token')).length, 1)
  assert.equal(fake.calls[0].auth, `Basic ${btoa('id:secret')}`)
  assert.ok(fake.calls.some(call => call.url.startsWith('https://us.api.blizzard.com/sc2/metadata/profile/1/2/5')))
  assert.ok(fake.calls.filter(call => !call.url.endsWith('/token')).every(call => call.auth === 'Bearer t1'))

  const before = fake.calls.length
  await directory.describe([eu('77'), eu('404')], signal)
  assert.equal(fake.calls.length, before, 'answers are kept')
  fake.advance(7200)
  await directory.describe([eu('77'), eu('404')], signal)
  const asked = fake.calls.slice(before).map(call => call.url.replace(/\?.*/, ''))
  assert.deepEqual(asked, ['https://oauth.battle.net/token', 'https://eu.api.blizzard.com/sc2/metadata/profile/2/1/404'],
    'a missing profile is asked again after an hour with a renewed token; a found one is kept for six')
})

test('unsafe portrait links are dropped; API failures reject without the secret; bad handles are not asked', async () => {
  const fake = api()
  const directory = createProfileDirectory({ clientId: 'id', clientSecret: 'secret-value' }, fake)
  assert.equal((await directory.describe([eu('66')], signal)).get(profileKey(eu('66'))).avatarUrl, undefined)
  await assert.rejects(directory.describe([eu('500')], signal), error => /answered 500/.test(error.message) && !error.message.includes('secret'))
  assert.equal((await directory.describe([{ region: 5, realm: 1, id: '1' }], signal)).get('5-1-1'), null, 'no API for this region')
  const refused = createProfileDirectory({ clientId: 'id', clientSecret: 'secret-value' }, api({ tokenStatus: 401 }))
  await assert.rejects(refused.describe([eu('1')], signal), error => /refused the client \(401\)/.test(error.message) && !error.message.includes('secret'))
  assert.throws(() => createProfileDirectory({ clientId: '', clientSecret: '' }), /required/)
})
