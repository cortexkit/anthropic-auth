import { expect, test } from 'bun:test'
import * as publicApi from '../index.ts'
import { createNativeCustody } from '../native-custody.ts'
import { createNativeLocalCredentialService } from '../native-local-credential-service.ts'
import { createNativeMenuExecutor } from '../native-menu-executor.ts'
import { getNativeMenuModel } from '../native-menu-model.ts'
import { captureNativeLocalPoolBinding } from '../pool-binding.ts'

test('Core exposes the existing native host factories without alternate implementations', () => {
  expect(publicApi.createNativeLocalCredentialService).toBe(
    createNativeLocalCredentialService,
  )
  expect(publicApi.createNativeCustody).toBe(createNativeCustody)
  expect(publicApi.getNativeMenuModel).toBe(getNativeMenuModel)
  expect(publicApi.createNativeMenuExecutor).toBe(createNativeMenuExecutor)
  expect(publicApi.captureNativeLocalPoolBinding).toBe(
    captureNativeLocalPoolBinding,
  )
})

test('native public factories do not expose internal runtime or authority publishers', () => {
  for (const name of [
    'updateNativeRuntime',
    'publishNativeLocalSuccess',
    'publishNativeLocalFailure',
    'publishNativeFirstIdentity',
    'assertNativePoolAuthority',
    'createNativeRefreshCoordinator',
    'buildNativeRosterSeed',
  ])
    expect(Object.hasOwn(publicApi, name)).toBe(false)
})

test('the public menu getter preserves both host profiles', () => {
  for (const host of ['opencode', 'pi'] as const) {
    const exposed = publicApi.getNativeMenuModel(host)
    expect(exposed).toEqual(getNativeMenuModel(host))
    expect(exposed.host).toBe(host)
    expect(exposed.groups.length).toBeGreaterThan(0)
    expect(new Set(exposed.groups.map((group) => group.id)).size).toBe(
      exposed.groups.length,
    )
  }
})
