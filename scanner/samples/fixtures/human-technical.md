# Postgres upgrade runbook, 14 → 16

Read this whole thing before you start. The rollback window closes once you run
`pg_upgrade --link`, and there is no undo after that point.

## Before the window

Take a base backup and verify you can restore it somewhere else. A backup you
have not restored is not a backup. Check `pg_stat_activity` for long-running
transactions; anything older than an hour will block the upgrade and you want to
kill it deliberately rather than discover it at 2am.

Run `pg_upgrade --check` first. It will tell you about incompatible extensions.
Ours were `pg_stat_statements` and `postgis`; both needed the matching version
installed before the upgrade would proceed.

## During

Stop the writers first, not the database. Connection draining takes about 90
seconds on our fleet. Then stop Postgres, run the upgrade, and start it again.
Expect eight to twelve minutes of downtime for a 400GB cluster on NVMe.

Run `ANALYZE` immediately. The planner statistics do not carry over and query
plans will be terrible until you do. We forgot this once and spent forty minutes
debugging a "performance regression" that was our own fault.
