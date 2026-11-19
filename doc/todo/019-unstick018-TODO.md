> Run with: Opus 5.5 / high
> Machine: mac (the stuck run's log is here)

# Unstick task 018

## Original Requirement

[NEVER REMOVE]

The runner ran `doc/todo/018-doesnTPickTodo-TODO.md` twice and neither run renamed it to -DONE or
-BLOCKED, so it is skipped now and its card waits in TODO.

Find out why: read that run's transcript `/Users/klarity/Documents/GitHub/klarity-claude-kit/doc/todo/018-doesnTPickTodo.log` and the work it
left (`git stash list` — the runner parks a dirty run's work there). Then finish the
task itself: do what is left, append its `## Results` and rename it -DONE.md — or,
when a person must act, say exactly what and rename it -BLOCKED.md. If the cause is in
the runner or the /todo skill rather than the task, say so in this file's Results.
