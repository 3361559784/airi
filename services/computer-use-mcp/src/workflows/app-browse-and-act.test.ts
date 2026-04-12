import { describe, expect, it } from 'vitest'

import { createAppBrowseAndActWorkflow } from './app-browse-and-act'

describe('app-browse-and-act workflow', () => {
  it('creates workflow with default parameters', () => {
    const workflow = createAppBrowseAndActWorkflow()
    expect(workflow.id).toBe('app_browse_and_act')
    expect(workflow.name).toBe('Browse and act in Google Chrome')

    const ensureAppStep = workflow.steps.find(s => s.kind === 'ensure_app')
    expect(ensureAppStep?.params?.app).toBe('Google Chrome')

    const typeIntoStep = workflow.steps.find(s => s.kind === 'type_into')
    expect(typeIntoStep).toBeUndefined()
  })

  it('creates workflow with custom parameters including url', () => {
    const workflow = createAppBrowseAndActWorkflow({
      app: 'Safari',
      goal: 'Find a recipe',
      url: 'https://example.com',
    })

    expect(workflow.name).toBe('Browse and act in Safari')
    expect(workflow.description).toContain('Find a recipe')

    const ensureAppStep = workflow.steps.find(s => s.kind === 'ensure_app')
    expect(ensureAppStep?.params?.app).toBe('Safari')

    const typeIntoStep = workflow.steps.find(s => s.kind === 'type_into')
    expect(typeIntoStep).toBeDefined()
    expect(typeIntoStep?.params?.text).toBe('https://example.com')
  })
})
