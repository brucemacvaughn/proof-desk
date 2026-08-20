# Why we moved off Kubernetes

In today's rapidly evolving infrastructure landscape, we made the decision to
migrate away from Kubernetes last quarter. It is important to note that this
choice came down to a number we finally measured: 40% of our platform team's
time was going to cluster maintenance rather than to anything our customers
could see.

The initial appeal was clear. Kubernetes offered a robust solution for
orchestrating our growing fleet of services, and it delivered on that promise.
Moreover, the ecosystem was mature enough that most problems we hit had been
solved by someone else first. Furthermore, the tooling allowed us to leverage
cutting-edge deployment patterns.

What changed was scale, or rather the lack of it. We have eleven services and
about forty containers at peak. That is not enough to justify the operational
surface area. Our upgrade cycle took two engineers a week, four times a year,
and twice it caused an incident.

We moved to ECS Fargate. The migration took six weeks and cost us one weekend of
degraded performance. In conclusion, cluster maintenance is now roughly two
hours a month.
