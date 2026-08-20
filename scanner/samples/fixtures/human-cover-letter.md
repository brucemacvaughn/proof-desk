Priya,

Saw the staff role on payments. I want it, and here's my case.

I spent four years at Halyard on dispatch — the thing that decides which driver
gets which load. Payments was adjacent and I kept ending up in it, mostly
because the retry logic was mine and it kept breaking in interesting ways.

The number I'd point at: payment retry failures went from 3.4% to 0.6% after I
rewrote the idempotency layer. That took two months and one very bad week in
March where I made it worse before I made it better. Happy to walk through what
I got wrong there, it's the more useful half of the story.

I don't have fintech background. I've never worked under PCI scope. If that's
disqualifying, no hard feelings — but I learn fast and I've got scar tissue from
running money-adjacent systems that mostly didn't lose money.

Ben Ortiz
512-555-0147
