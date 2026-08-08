/**
 * @klum-db/lobby notifications — device registration (#39).
 *
 * Registrations live in a `devices` collection inside the notifications
 * vault, beside the notifications they wake. The writing session must READ
 * a recipient's endpoints in order to wake them, so every actor who may
 * emit a notification must be able to read them — and they already hold a
 * grant on that vault. This adds no new grant step and widens no trust
 * boundary: anyone who can read an endpoint can already read every
 * notification.
 *
 * Known metadata exposure: a grant holder can enumerate which actors have
 * registered devices and of what kind. Accepted within the fleet boundary,
 * on the same reasoning as the registry and the records themselves.
 *
 * @module
 */
import { sha256Hex } from '@noy-db/hub/cargo'

/** Collection holding device registrations, inside the notifications vault. */
export const DEVICES_COLLECTION = 'devices'

export type DeviceKind = 'web-push' | 'apns' | 'fcm'

/** What a `WakeSender` is given — no actor, no content, just where to knock. */
export interface DeviceEndpoint {
  readonly endpointId: string
  readonly kind: DeviceKind
  readonly token: string
}

export interface DeviceRegistration extends DeviceEndpoint {
  readonly actor: string
  readonly registeredAt: number
  /** Optional human label, e.g. 'phone'. Never used for routing. */
  readonly label?: string
}

export interface RegisterDeviceInput {
  actor: string
  kind: DeviceKind
  token: string
  label?: string
}

/** The collection surface this needs. */
export interface DeviceStore {
  list(): Promise<unknown>
  query(): { toArray(): DeviceRegistration[] }
  get(id: string): Promise<DeviceRegistration | null>
  put(id: string, row: DeviceRegistration): Promise<void>
  delete(id: string): Promise<void>
}

/**
 * Deterministic endpoint id, so re-registering the same device is
 * idempotent instead of accumulating duplicates. Components are
 * length-prefixed so a delimiter inside a token cannot forge another
 * tuple's id — the same guard as `deriveNotificationId`.
 */
export async function deriveEndpointId(kind: DeviceKind, token: string): Promise<string> {
  const parts = [kind, token]
  const joined = parts.map((p) => `${p.length}:${p}`).join('|')
  return sha256Hex(new TextEncoder().encode(joined))
}

export class DeviceRegistry {
  constructor(
    private readonly store: DeviceStore,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Register (or re-register) a device. Idempotent by derived endpoint id. */
  async register(input: RegisterDeviceInput): Promise<DeviceRegistration> {
    const endpointId = await deriveEndpointId(input.kind, input.token)
    const row: DeviceRegistration = {
      endpointId,
      actor: input.actor,
      kind: input.kind,
      token: input.token,
      registeredAt: this.now(),
      ...(input.label !== undefined ? { label: input.label } : {}),
    }
    await this.store.put(endpointId, row)
    return row
  }

  /** One actor's registered devices. */
  async list(actor: string): Promise<DeviceRegistration[]> {
    await this.store.list()
    return this.store.query().toArray().filter((d) => d.actor === actor)
  }

  /** Every registration in the fleet. */
  async listAll(): Promise<DeviceRegistration[]> {
    await this.store.list()
    return this.store.query().toArray()
  }

  /** Remove a registration. Unknown ids are a no-op. */
  async unregister(endpointId: string): Promise<void> {
    await this.store.delete(endpointId)
  }
}
