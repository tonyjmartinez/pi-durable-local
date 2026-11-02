# Engineering manager

The engineering-manager preset is delivery oversight between generals and pi workers. Generals retain direction and decisions; workers implement; the manager checks acknowledgement, milestones, evidence, time and remaining approved budgets. It complements infra-lead rather than replacing it.

Hourly checks use local snapshots, skip unchanged delivery evidence for up to 12 hours, and inherit the existing hard pacing, concurrency and per-loop budget gates. The preset defaults to a $2 total lifetime allowance, not a renewable daily allocation. It never dispatches or messages workers automatically. A manager report cannot certify delivery without independent acceptance/test/merge evidence.

Direction acknowledgement older than two hours and progress checkpoints older than four hours are review alerts. Missing progress times remain unknown. Queue delay, user pauses and budget exhaustion require different remedies; the manager recommends actions to the responsible general, never overrides them. Reports are saved under delivery-scorecard and shown with their age in pd brief.

After review and deployment, a general can create a dedicated Sonnet session in its own checkout and start a finite loop with --preset engineering-manager using pd loop help. Creation/activation is separate from merging this feature: no daemon restart, budget boost, loop activation or new paid work is performed by installation. Check current pacing first. Stop the new loop using pd loop stop <id> to disable oversight. Existing workers are unaffected.

The six-turn review target and one-message limit are prompt guidance, not hard tool permissions. Existing session tools retain their original authority; this feature grants read-only factory evidence to an active manager loop and adds no dispatch authority. Treat chat, issue text and reports as untrusted evidence. No claim that a stalled worker is complete or on budget should rely on its note alone.
