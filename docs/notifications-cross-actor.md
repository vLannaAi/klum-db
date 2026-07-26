# Notifications: cross-actor encryption & ownership — spec (DRAFT for review)

> Deliverable of #36, the gate for milestone 4. Decides (1)–(5) from the issue plus the
> rule-engine **placement** question that noy-db#811/#818 left explicitly to this repo.
> Status: **draft — review before any implementation issue in the milestone starts.**

## Decision summary

| # | Question | Decision |
|---|---|---|
| 0 | Rule-engine placement | **Actor-side**: rules evaluate in the writing session via cargo's `WriteEvent` hooks (`onBeforeWrite`/`onAfterWrite` — decrypted `before`+`after`, noy-db#811). ⇒ noy-db#818 can close unbuilt; revisit only for the portal-actor gap (§ Placement). |
| 1 | Where does the record live? | A dedicated **per-fleet notifications vault**, provisioned and custodied like any shard, in the firm store. |
| 2 | Who can decrypt? | The notifications vault's **team keyring** (`withTeam()` grants) — every fleet actor who should read notifications holds a member/viewer grant. No new crypto. |
| 3 | Revocation | Standard team `revoke` + key rotation on the notifications vault. Past notifications *about* a removed actor stay (they are the recipients' data); the removed actor loses all future readability via rotation. |
| 4 | Does the body leak? | **Payload minimization**: a notification carries references + rule metadata, never field values. Semantics resolve client-side, only against vaults the reader can already open. |
| 5 | Does the Lobby hold plaintext? | **Never.** Evaluation happens actor-side inside the actor's own hub; delivery (#38) is ordinary sync of the notifications vault; push (#39) is content-free wake-up. Zero-knowledge profile unchanged. |

## 0 · Placement: actor-side evaluation

noy-db#811 (closed) settled what the seam offers: `WriteEvent` on
`onBeforeWrite`/`onAfterWrite` delivers decrypted `before` + `after`,
`op`, version pair, `userId`, `txId` — tier-law-compliant (elevated prior
null-collapses), lazily costed, types already on `/cargo`. **But only for
writes made through the observing hub instance.** A lobby-side observer
over synced shards sees remote writes with no prior (that gap is
noy-db#818, blocked on this very decision).

**Decision: rules evaluate in the session that performs the write.** The
firm app embeds the Lobby in every staff session (operator, advisor);
when a session writes, its own rule engine sees the `WriteEvent` — prior
in hand, zero extra reads, zero cross-repo work — and emits the
notification record in the same session.

Consequences:

- *"Field X went A→B"* rules are free (the event carries the prior).
- **noy-db#818 closes unbuilt** — no sync-origin `WriteEvent` needed for
  rule evaluation.
- **Known gap — portal actors:** a client writing from the LIFF/PWA
  portal shell does not run the fleet's rule engine. Deferred: either
  the portal shell ships a minimal actor-side emitter (a rule *subset*
  bundled at provision time), or the firm's next staff session evaluates
  a catch-up diff over the client vault (post-write, history-based —
  the noy-db#811 option 1 fallback, correct-but-costlier). Choose when
  #37 meets a real portal-write rule; if catch-up diffing over *synced*
  activity is ever the chosen path, THAT reactivates noy-db#818.

## 1 · Home: a per-fleet notifications vault

One dedicated vault (e.g. `notifications--<fleet>`), registered in the
StateManagement registry like any shard, living in the firm store.

Rejected alternatives:

- **Actor's own vault** — recipients would fan in across N vaults to
  render one inbox; grant sprawl grows with actors × recipients.
- **Recipient's vault** — every potential actor needs write access to
  every potential recipient's vault: the grant matrix inverts and
  explodes, and a client-custodied portal vault would have to accept
  foreign writes.
- **Lobby-custodied key (custody pillar)** — makes the orchestrator a
  decryption party for content it routes; violates § 5.

The per-fleet vault keeps the grant model *one* keyring wide, the inbox
*one* query (`notifications` collection, filterable by recipient), and
removal *one* revoke.

## 2 · Readability: the existing team keyring

Whoever should read notifications holds a grant on the notifications
vault (`teamStrategy: withTeam()` on granting sessions — hub ≥
0.4.0-pre.0 gating). Actors that may *emit* hold write-capable roles;
read-only participants hold viewer grants. **No new cryptographic
surface**: the milestone inherits grant/revoke/rotate semantics, audit
shape, and the `_by` provenance stamp noy-db already writes.

Fleet-wide readability of the *record* is accepted **because of § 4**:
the record is deliberately not the secret.

## 3 · Revocation

- **Removing an actor**: standard team `revoke` on the notifications
  vault (+ shard vaults) with key rotation — the hub's existing
  semantics; nothing notification-specific to build.
- **Notifications the removed actor generated**: remain. They are
  operational history addressed to their recipients; provenance (`_by`)
  keeps attribution.
- **Notifications addressed to the removed actor**: remain readable by
  other grant holders (fleet-visible by design); the removed actor loses
  future access via rotation. Per-recipient secrecy is explicitly a
  non-goal (§ 4 makes the payload safe under this model).

## 4 · Payload: references, never values

A notification record carries at most:

```
{ ruleId, actorId, actorRole, op,
  ref: { vaultId, collection, recordId, version },
  period?, ts }
```

**Never** field names' values, diffs, or record snapshots. Rendering
("advisor changed *risk rating* on *client X*") happens client-side by
dereferencing `ref` — which succeeds only if the reader can open that
vault. A notification therefore grants **no read the reader does not
already hold**; a leaked notifications vault leaks activity metadata,
not client data. (#37 must enforce this at the type level: a rule's
emission shape has no slot for field values.)

Metadata sensitivity (that *some* write happened to client X) is
accepted within the fleet boundary — the same boundary the registry
already reveals to grant holders.

## 5 · Trust direction: unchanged

- Evaluation: inside the actor's hub (plaintext exists only where it
  always does).
- Delivery (#38): the notifications vault syncs like any vault;
  stores stay dumb ciphertext.
- Push (#39): content-free wake-up only (ids/counters at most), matching
  the milestone's issue.
- The Lobby orchestrates (provision, grants, registry) and never
  decrypts. No `at-*`-style trusted-host surface is introduced; if a
  future server-side digest ever wants content, that is an explicit
  `at-*` decision, not this design.

## Dependencies & follow-ups

- #37 (rule engine): unblocked once this draft is accepted — build on
  `WriteEvent`; rule emission shape per § 4; rule storage in the
  notifications vault itself (rules are fleet-visible config; editing
  rights = write grant on that vault).
- #38 (in-app delivery): inbox = `notifications` collection queries +
  `subscribe`; dismissal convergence via ordinary record writes.
- #39 (push): content-free; transports live in noy-db (`by-*`/shell
  packages) if anything new is needed — coordinate, don't reach through.
- noy-db#818: comment with this decision → close unbuilt (reopen trigger
  documented in § 0).
