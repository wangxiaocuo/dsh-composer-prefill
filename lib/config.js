/**
 * Configuration readers shared by the Host half.
 *
 * Cordis/schemastery may hand `apply` either plain values or live schema refs
 * (`.get()`), so both shapes are accepted.
 */

/**
 * @param {unknown} config effective row configuration.
 * @param {string} key field name.
 * @param {unknown} fallback value used when the field is absent.
 * @returns {unknown} the effective value.
 */
export function readConfig(config, key, fallback) {
  const raw = config === null || config === undefined ? undefined : config[key]
  if (raw === undefined || raw === null) return fallback
  if (typeof raw === 'object' && typeof raw.get === 'function') {
    const value = raw.get()
    return value === undefined || value === null ? fallback : value
  }
  return raw
}

/**
 * @param {unknown} value candidate.
 * @param {number} fallback value used when the candidate is not a usable number.
 * @returns {number} a finite, non-negative number.
 */
export function readNumber(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback
}

/**
 * @param {unknown} value candidate.
 * @param {string} fallback value used when the candidate is not a string.
 * @returns {string} the string, or the fallback.
 */
export function readString(value, fallback) {
  return typeof value === 'string' ? value : fallback
}
