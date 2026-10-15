const requiredString = (value, name) => {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`authored-text format ${name} must be a non-empty string`)
  }
  return value
}

export function defineAuthoredTextFormat(specification) {
  if (typeof specification !== 'object' || specification === null || Array.isArray(specification)) {
    throw new TypeError('authored-text format specification must be an object')
  }
  const formatId = requiredString(specification.formatId, 'formatId')
  const offerId = requiredString(specification.offerId, 'offerId')
  const evidenceId = requiredString(specification.evidenceId, 'evidenceId')
  const label = requiredString(specification.label, 'label')
  if (typeof specification.validate !== 'function') {
    throw new TypeError('authored-text format validate must be a function')
  }
  return Object.freeze({
    formatId,
    offerId,
    evidenceId,
    label,
    validate: specification.validate,
  })
}
