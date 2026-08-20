# Notes on the Q3 retro

We shipped four of the six things we committed to. The two that slipped were the
billing migration and the mobile push work, both for the same reason: we
underestimated how much of the existing code we would have to touch first.

The billing migration is worth delving into. We scoped it as a two-week job
based on the assumption that the payment records were normalized. They were not.
About 12% of records predate a schema change from 2021 and carry the old shape,
which meant writing a backfill before we could write the migration.

Moreover, we lost a week to the on-call rotation being thinner than usual. The
backfill itself was a fairly robust piece of work and I would leverage it again
for the next one.

What we would do differently: sample the data before scoping, not after. We now
have a rule that any migration estimate over a week requires someone to actually
query production first.
