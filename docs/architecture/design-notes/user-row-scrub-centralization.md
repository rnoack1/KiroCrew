# Follow-up: centralize the user-row scrub into `ConversationLog.append`

**Status:** open, tracked · **Owner:** the module owner of `src/kiro_crew/history.py`
**Expiry:** revisit at the next change to any `_USER_ROW_PERSISTERS` member, and no
later than the next release cycle after the egress-hardening change lands.

## The interim shape, and why it is interim

Inbound `user` rows are scrubbed at **13 call sites** rather than at one chokepoint.
The set is enumerated in `_USER_ROW_PERSISTERS` and held together by
`TestEveryUserRowPersisterScrubs`, which pins the set bidirectionally and resolves
every user-row call site to its enclosing function, requiring the redactor in that
scope. A new module fails the set pin; a new unscrubbed call site inside a listed
module fails the per-site arm.

That test is what makes the shape safe, not a promise — but it is still 13 places
enforcing one rule. The smaller, correct-by-construction shape is a
`redact_user: bool = True` parameter on `ConversationLog.append`, with the scrub
applied inside it.

## Why it was not done in the same change

`_redact_at_write_boundary`'s `role != "user"` gate also covers the **dashboard's own
write-back**, so flipping the default is a product-wide behaviour change rather than a
fix to the inbound-transport leak. Specifically, the beneficiary of the `user` exemption
is slot rehydration: `dashboard/chat_backfill.py` reads back through
`read_messages_chained`, so a default-on scrub changes **model input on session resume**,
not merely what is stored.

## What closing this requires

1. Add `redact_user: bool = True` to `ConversationLog.append` and move the scrub inside.
2. Have the dashboard write-back opt out explicitly, and decide deliberately whether
   rehydrated `user` text is scrubbed — that is the product call this note defers.
3. Delete the 13 call-site invocations, and convert `TestEveryUserRowPersisterScrubs`
   from a per-site pin into a chokepoint assertion plus an opt-out allowlist.
4. Keep a test that fails if a new persister bypasses `append` entirely.

Until step 2 is ruled, the 13-site shape plus its ratchet is the safe interim.
