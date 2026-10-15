/** Compile boundary only: runtime imports the independently built Style/Wizard owners, never their source graphs. */
import type { LanguageProvider } from '@modkit/sdk'
export function createSc2StyleLanguageProvider(): LanguageProvider
export function createSc2WizardLanguageProvider(): LanguageProvider
