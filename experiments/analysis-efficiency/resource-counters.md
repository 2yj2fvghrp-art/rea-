# Resource counters at payload completion

Continues [#2016](https://github.com/morluto/rea/issues/2016) from merged main
`4f4f6cd7b5d7a400b90772a138d7b9f942c2a556`. A transient cgroup can disappear
before the existing supervisor reads terminal counters. Earlier reports keep
those counters unknown; sampled zero events are not final no-OOM proof.

An optional `resource-run.py --observe-payload-exit -- COMMAND...` adds one small
observer inside the same owned scope. It waits for the direct payload, records
kernel `memory.peak`, CPU and memory/task events, and reports remaining processes
before acknowledging completion to the outer supervisor. The observer remains
alive until receipt acknowledgement, bounded by the existing ten-second cleanup
interval. Payload stdio and process exit status remain observable.

The receipt phase is **payload-exited-observer-alive**. The supervisor validates
the owned-unit token, numeric fields, cgroup identity, live observer membership,
payload exit status and absence of additional processes before marking that
observation verified. Wrong-owner, malformed, missing or inconsistent receipts
stay unknown; lingering actors stay explicit and cannot certify cleanup.
Unexpected metadata is omitted rather than copying an inherited environment.

This is not a final whole-scope counter: the observer still has to exit. Existing
`resource_events_final` and `resource_counters_verified` retain their original
meaning and unknown state. The grader's existing full resource gate is unchanged.
Earlier runs and source/runtime hashes are not relabeled. Observer CPU/memory and
acknowledgement time are included in this new measurement mode; comparable runs
must use the same mode. Default commands do not start an observer or add fields.

One CPU, the unchanged 3 GiB early-stop/4 GiB hard ceiling, no swap, task limits
and host-available-memory safeguards remain in force. No resource limit is raised.
Cleanup uses the uniquely owned systemd scope, without signaling a process merely
because a recorded PID exists. Failed scope cleanup retains the named owner.

## Focused verification

Four semantic Python cases cover nonzero exit/kernel facts, missing or malformed
receipts, wrong ownership, integer types, contradictory cleanup, lingering actors,
foreign symlinks and exclusion of unrelated metadata. They join the existing
Python gate; simulated receipts do not establish actual cgroup behavior.

Actual Linux cgroup/systemd probes additionally verify:

- Default mode keeps its receipt shape and success status.
- Success and exit-code 3 preserve the payload outcome and verify a sole observer.
- A bounded 16 MiB Node allocation yields a kernel peak, including work that the
  100 ms sampler can miss.
- A payload leaving a child reports both actors and refuses verification; the
  supervisor retires the owned scope.
- A caller-selected task ceiling of 4 triggers the existing task-limit early stop
  with exit 125 and an unverified observation.
- Interrupting a confirmed-live owned controller preserves failure and retires
  its scope; missing completion counters are not replaced with zeros.

These are metering/lifecycle probes, not a new model/provider performance claim.
Actual REA workflows and repeated observer-overhead measurements remain necessary
before relying on the new mode for domain comparisons. Raw receipts remain in
the private experiment lab outside Git.
