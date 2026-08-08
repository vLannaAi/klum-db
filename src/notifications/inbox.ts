/**
 * @klum-db/lobby notifications — the inbox (#38).
 *
 * Read side of delivery. Expiry is a READ-TIME FILTER: `expiresAt` is
 * stored and excluded here, with no sweeper — no scheduler, no background
 * writes, no cross-device contention. An expired notification simply stops
 * appearing.
 *
 * @module
 */
import type { NotificationRecord } from './record.js'

/** The collection surface the inbox needs. */
export interface InboxStore {
  list(): Promise<unknown>
  query(): { toArray(): NotificationRecord[] }
  get(id: string): Promise<NotificationRecord | null>
  put(id: string, record: NotificationRecord): Promise<void>
}

export interface ListOptions {
  recipient: string
  /** Include records the recipient already dismissed. Default false. */
  includeDismissed?: boolean
  /** Injectable clock for the expiry filter. Defaults to `Date.now()`. */
  now?: number
}

export class NotificationInbox {
  constructor(private readonly store: InboxStore) {}

  /** The recipient's notifications, newest first. Excludes expired, and dismissed unless asked. */
  async list(opts: ListOptions): Promise<NotificationRecord[]> {
    const now = opts.now ?? Date.now()
    // The hub hydrates lazily — query() sees nothing until list() has run.
    await this.store.list()
    return this.store
      .query()
      .toArray()
      .filter((r) => r.recipient === opts.recipient)
      .filter((r) => opts.includeDismissed === true || r.dismissedAt == null)
      .filter((r) => r.expiresAt === undefined || r.expiresAt > now)
      .sort((a, b) => b.createdAt - a.createdAt)
  }

  /** How many undismissed, unexpired notifications the recipient has. */
  async unreadCount(recipient: string, opts: { now?: number } = {}): Promise<number> {
    const list = await this.list({ recipient, ...(opts.now !== undefined ? { now: opts.now } : {}) })
    return list.length
  }

  /** Stamp `dismissedAt`. Idempotent: an already-dismissed record keeps its first timestamp. */
  async dismiss(id: string, opts: { at?: number } = {}): Promise<void> {
    const existing = await this.store.get(id)
    if (existing === null) throw new Error(`notification "${id}" not found.`)
    if (existing.dismissedAt != null) return
    await this.store.put(id, { ...existing, dismissedAt: opts.at ?? Date.now() })
  }
}
