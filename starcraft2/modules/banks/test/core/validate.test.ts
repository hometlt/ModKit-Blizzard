import { describe, expect, it } from 'vitest'
import { calculateBankSignature, validateBank } from '../../shared/core/index.js'

const INFO = { bankName: 'Bank', authorId: '2-S2-1-20', playerId: '2-S2-1-10' }

describe('validateBank', () => {
  it('reports duplicate keys and invalid typed values', () => {
    const report = validateBank({
      sections: [
        {
          name: 'Stats',
          keys: [
            { name: 'Score', value: { type: 'int', value: 'abc' } },
            { name: 'Score', value: { type: 'point', value: '1,nope' } },
            { name: 'Mystery', value: { type: 'custom', value: 'x' } },
          ],
        },
      ],
    })

    expect(report.ok).toBe(false)
    expect(report.findings.map(finding => finding.code)).toEqual([
      'invalid-int',
      'duplicate-key',
      'invalid-point',
      'unknown-value-type',
      'missing-signature',
    ])
  })

  it('verifies valid signatures and rejects invalid ones', () => {
    const bank = {
      sections: [{ name: 'Stats', keys: [{ name: 'Score', value: { type: 'int', value: '7' } }] }],
    }
    const signed = { ...bank, signature: calculateBankSignature(bank, INFO) }

    expect(validateBank(signed, { signatureInfo: INFO }).findings.map(finding => finding.code)).toEqual(['valid-signature'])
    expect(validateBank({ ...signed, signature: 'BAD' }, { signatureInfo: INFO }).findings.map(finding => finding.code)).toEqual(['invalid-signature'])
  })
})
