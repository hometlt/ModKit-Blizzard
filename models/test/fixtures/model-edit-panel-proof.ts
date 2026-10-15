// Integrated into the existing real browser host fixture, not a separate browser runner.
import { createEditPanel } from '../../../../modkit-core/apps/web/src/edit-panel.js'
import {
  presentationSlotId,
  type AnyDescriptor,
  type AssetEditPlan,
  type OperationSession,
  type JsonValue,
} from '@modkit/sdk'
import type {
  WebSubjectEditor,
  EditApplyStatus,
} from '../../../../modkit-core/apps/web/src/editing.js'

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message)
}

export async function driveModelEditPanel(options: {
  readonly descriptor: AnyDescriptor
  readonly operations: OperationSession
  readonly editor: WebSubjectEditor
  readonly input: JsonValue
  readonly assertUnchanged: () => Promise<void>
  readonly reopen: () => Promise<AnyDescriptor>
}): Promise<{
  readonly plan: AssetEditPlan
  readonly applied: EditApplyStatus
  readonly elapsedMs: number
  readonly evidence: {
    readonly formId: string
    readonly operationId: string
    readonly sourceUnchangedBeforeCommit: true
    readonly reopened: true
    readonly visibleVersionField: false
  }
}> {
  const root = document.createElement('div')
  document.body.append(root)
  let captured: AssetEditPlan | undefined
  let applied: EditApplyStatus | undefined
  let outcome: string | undefined
  let didReopen = false
  let reopenedDescriptor: AnyDescriptor | undefined
  let resolveCompletion: (() => void) | undefined
  const completion = new Promise<void>(resolve => {
    resolveCompletion = resolve
  })
  const panel = createEditPanel({
    portsFor: () => ({
      planFromOperation(output) {
        captured = options.editor.planFromOperation(output)
        return captured
      },
      async applyPlan(plan) {
        await options.assertUnchanged()
        applied = await options.editor.applyPlan(plan)
        return applied
      },
    }),
    async reopen() {
      reopenedDescriptor = await options.reopen()
      didReopen = true
      return true
    },
    lastOutcome: () => outcome,
    recordOutcome: (_descriptor, text) => {
      outcome = text
    },
    onStatus: status => {
      if (status.failed) outcome = status.message
    },
  })
  const mountArgs = {
    container: root,
    descriptor: options.descriptor,
    operations: options.operations,
    slot: {
      slotId: presentationSlotId('m3-edit-form-proof'),
      kind: 'panel' as const,
      contributionId: 'org.example/m3-edit-form-proof',
      extensionId: 'org.example/test',
      priority: 1,
      bindings: [],
    },
    // This form has no selector/reference fields and requests no source lease.
    sources: { get: async () => undefined, getUnknown: async () => undefined },
  }
  let mounted = await panel.mount(mountArgs)
  let timer: ReturnType<typeof setTimeout> | undefined
  let observer: MutationObserver | undefined
  try {
    const selector = root.querySelector('[data-mk-part="form.select"]')
    check(selector instanceof HTMLSelectElement, 'ordinary Edit panel is absent')
    check(selector.value === 'uvm-json-edit', 'M3 did not publish the shared model edit form')
    check(
      root.querySelector('[name="schemaVersion"]') === null,
      'transport version leaked into model controls',
    )
    const set = (name: string, value: string) => {
      const control = root.querySelector(`[name="${name}"]`)
      check(
        control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement,
        `missing ${name} control`,
      )
      control.value = value
      control.dispatchEvent(new Event('input', { bubbles: true }))
      control.dispatchEvent(new Event('change', { bubbles: true }))
    }
    check(
      options.input !== null && typeof options.input === 'object' && !Array.isArray(options.input),
      'form input is not an object',
    )
    const input = options.input as Readonly<Record<string, JsonValue>>
    check(
      typeof input['metersPerSourceUnit'] === 'number' && Array.isArray(input['json']),
      'form input fields absent',
    )
    set('metersPerSourceUnit', String(input['metersPerSourceUnit']))
    set('json', JSON.stringify(input['json']))
    const apply = root.querySelector('[data-mk-part="form.button"]')
    check(apply instanceof HTMLButtonElement && !apply.disabled, 'Edit panel Apply unavailable')
    const started = performance.now()
    observer = new MutationObserver(() => {
      // The real panel removes disabled only after its whole invoke/apply/reopen promise settles.
      if (!apply.disabled) resolveCompletion?.()
    })
    observer.observe(apply, { attributes: true, attributeFilter: ['disabled'] })
    apply.click()
    await Promise.race([
      completion,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Edit panel timed out: ${outcome ?? root.textContent}`)),
          120000,
        )
      }),
    ])
    check(
      captured !== undefined,
      `Edit panel produced no native plan: ${outcome ?? root.textContent}`,
    )
    check(
      applied !== undefined && !applied.failed,
      `Edit panel did not commit: ${outcome ?? root.textContent}`,
    )
    check(didReopen, `Edit panel failed to reopen: ${outcome ?? root.textContent}`)
    check(reopenedDescriptor !== undefined, 'reopened descriptor absent')
    await mounted.unmount()
    mounted = await panel.mount({ ...mountArgs, descriptor: reopenedDescriptor })
    check(
      root.textContent?.includes('the tab was reopened'),
      'remounted Edit panel did not report reopened state',
    )
    return {
      plan: captured,
      applied,
      elapsedMs: performance.now() - started,
      evidence: {
        formId: selector.value,
        operationId: 'model.edit',
        sourceUnchangedBeforeCommit: true,
        reopened: true,
        visibleVersionField: false,
      },
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    observer?.disconnect()
    await mounted.unmount()
    root.remove()
  }
}
