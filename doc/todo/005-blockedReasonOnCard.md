> Run with: Sonnet 5.5 / medium

# Show a repo's blocked reason on each waiting task's card

Split out of task 003. A failed notify should not be the only trace of a wedged repo: when
`announceWaiting` (`runner/src/run.js`) finds tasks waiting behind a block, also write the
block reason to each task card's status comment (`status.js` — add a `waiting` kind to
`KINDS`; avoid `openStatus`'s initial "running" line flashing first). Document in `runner/README.md`.

_GitHub issue #5 — end the commit subject with `(#5)`._
