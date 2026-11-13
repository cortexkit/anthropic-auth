export type ThreeWayBoolean = boolean | 'default' | 'on' | 'off'

/** Preserve each reader's legacy default when the setting is absent or default. */
export function readThreeWayBoolean(
  value: ThreeWayBoolean | undefined,
  absent: boolean,
): boolean {
  if (value === 'on') return true
  if (value === 'off') return false
  return typeof value === 'boolean' ? value : absent
}

/** Encode legacy booleans without choosing a reader-specific policy for absence. */
export function toThreeWay(
  value: ThreeWayBoolean | undefined,
): 'default' | 'on' | 'off' {
  if (value === true || value === 'on') return 'on'
  if (value === false || value === 'off') return 'off'
  return 'default'
}
