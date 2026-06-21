# Positioning — where klum-db sits

Why `@klum-db/lobby` exists, who it's for, and how it relates to the wider data-sovereignty landscape. (The 20-second intro is the [README](../README.md); the technical boundary is [architecture.md](./architecture.md).)

## The thesis — small, sovereign, coordinated

A dataset is strongest when it's **small, sovereign, and complete on its own**: its own embedded schema, its own query engine, its own keys, **100% encrypted**, usable **offline**. But completeness is also a ceiling — alone, a dataset can only answer for *itself*.

The usual fix is to centralize: pour everything into one big store so the data can finally meet. That buys reach and pays for it in sovereignty — one owner, one lock-in, one blast radius.

klum-db takes the other path. It **coordinates the vaults where they stand**: cross-vault queries, transfers, custody, and sync are planned across the group, each vault answering for its own slice under its own keys — nothing pools. Reach comes from **coordination, not consolidation**. *Small enough to own, coordinated enough to scale.*

## The landscape — the company it keeps

- **Local-first software** ([Ink & Switch](https://www.inkandswitch.com/essay/local-first/)) — "you own your data, in spite of the cloud": the full database lives with you, works offline, outlives the vendor, and is yours by *architecture*, not policy. klum-db's vaults are local-first; the Lobby adds the cross-vault layer the original essay leaves open.
- **Personal Data Stores / [Solid](https://solid.mit.edu/)** (Berners-Lee) — sovereign per-subject datastores that decouple data from apps. klum-db shares the "one subject, one vault, the subject holds the deed" model and adds an orchestration control plane across many.
- **[Federated analytics](https://arxiv.org/abs/2302.01326)** — "bring the computation to the data, not the data to a pile": operate across owner-controlled datasets without centralizing them. klum-db's cross-vault queries are this idea, made concrete and encrypted.

## The contrast — coordination without custody

The competitive frame is the **central data lake**, and the contrast is architectural, not moral:

| Central data pool | klum-db |
|---|---|
| One store owns the data | Each vault owns its own; the orchestrator owns none |
| One honeypot to breach | No single point of failure; keys never pool |
| Lock-in / lock-out | Portable, forkable, individually revocable vaults |
| Non-interoperable by design | Interoperable across independently-owned vaults |

**Coordination without custody** — the orchestrator coordinates the fleet but never holds the data. *Borrow, don't take:* access is scoped, purpose-limited, and revocable.

## Governance, by default

Sovereignty maps onto real, legally-grounded governance — and the design makes it the *default*, not a checklist:

- **Data portability** ([GDPR Art. 20](https://gdpr-info.eu/art-20-gdpr/)) — vaults are self-contained and movable by construction.
- **Data minimization & purpose limitation** ([Art. 5](https://gdpr-info.eu/art-5-gdpr/)) — Surface sync ships only the agreed, field-projected slice.
- **Privacy by design & by default** ([Art. 25](https://gdpr-info.eu/art-25-gdpr/)) — governance is a property of the system, not a task bolted on.
- **Revocable consent** — the subject holds the deed and can withdraw anytime (Custody).

*Governance by default, not by checklist* — compliance that travels with the data and stays out of the way of daily work.

## "Unity is strength" — the lineage

The thesis is old: many independent parts, joined, are stronger than the sum — without dissolving into one. Worth a nod: **l'union fait la force** (Belgium, 1830) and **Aesop's bundle of sticks** (one rod snaps; the bound bundle holds). klum-db is a **group** — *joined, not merged; allied, not absorbed* — never a *cluster* of fungible replicas.

## Further reading

- [Local-first software: you own your data, in spite of the cloud](https://www.inkandswitch.com/essay/local-first/) — Ink & Switch
- [Solid](https://solid.mit.edu/) (Personal Data Stores, Berners-Lee) · [Personal Data Stores: a review (PMC)](https://pmc.ncbi.nlm.nih.gov/articles/PMC9921726/)
- [Federated Analytics: a survey](https://arxiv.org/abs/2302.01326)
- GDPR [Art. 20 — portability](https://gdpr-info.eu/art-20-gdpr/) · [Art. 5 — principles](https://gdpr-info.eu/art-5-gdpr/) · [Art. 25 — privacy by design](https://gdpr-info.eu/art-25-gdpr/)
