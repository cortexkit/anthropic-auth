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
