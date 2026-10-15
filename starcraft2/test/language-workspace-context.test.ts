import { describe, expect, it } from 'vitest'
import { languageWorkspaceIsSemanticallyIncomplete } from '../shared/language/workspace-context.js'

describe('language workspace semantic completeness', () => {
  it('separates a complete read-only dependency closure from legacy edit safety', () => {
    expect(
      languageWorkspaceIsSemanticallyIncomplete({
        workspaceIncomplete: true,
        workspaceContext: { semanticComplete: true },
      }),
    ).toBe(false)
    expect(
      languageWorkspaceIsSemanticallyIncomplete({
        workspaceIncomplete: false,
        workspaceContext: { semanticComplete: false },
      }),
    ).toBe(true)
    expect(languageWorkspaceIsSemanticallyIncomplete({ workspaceIncomplete: true })).toBe(true)
  })
})
