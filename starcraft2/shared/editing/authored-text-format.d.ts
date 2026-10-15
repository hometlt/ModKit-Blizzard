export interface AuthoredTextValidationBudget {
  readonly maxNodes: number
  readonly [name: string]: unknown
}

export interface AuthoredTextFormatSpecification {
  readonly formatId: string
  readonly offerId: string
  readonly evidenceId: string
  readonly label: string
  readonly validate: (text: string, budget: AuthoredTextValidationBudget) => void
}

export declare function defineAuthoredTextFormat(
  specification: AuthoredTextFormatSpecification,
): Readonly<AuthoredTextFormatSpecification>
