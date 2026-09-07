# Recipient-scoped single-use messaging

When one agent asks N recipients a question, issue N grants, each with one exact
`messageSendCapability(recipient, owner)` and `constraints.maxUses: 1`. A single
grant covering multiple recipients would share one usage budget across them.

The executable example is the consumer-level request scenario in
[`message-fanout.test.ts`](../../packages/core/src/message-fanout.test.ts):

```sh
pnpm typecheck
pnpm exec vitest run packages/core/src/message-fanout.test.ts
```

It exercises `messages.request`, a transport, and a reply router for 1 and 25
recipients, inside one turn authority lease -- the shape `SharedOSExecutor` runs
every turn in. Each recipient's first request races a duplicate. Exactly one
succeeds and one is denied, and there is exactly one delivery per recipient.

Which refusal the loser of that race is handed depends on whether it cleared
discovery before the winner consumed the ticket, so the concurrent case pins the
outcome and not the code. A separate ordered case pins the code: a bounded grant
whose budget is spent is not reach, so the replay is refused at discovery. The
caller is told `tool_unavailable` and learns nothing about the grant, while the
trusted audit event carries `grant_exhausted`. A consumer that needs to tell
"spent" from "never granted" reads audit, not the refusal.

These are authorization and dispatch tests, not a latency benchmark or a claim
that 25 model turns ran.

Additional cases show that an ungranted recipient cannot spend another ticket --
refused with `no_matching_grant`, because the asker still holds an unspent grant
and so the tool clears discovery -- that revoking one recipient leaves another
reachable, and that omitting the usage store fails closed before transport.
Every denial scenario has an allowed control in the same suite.

## Host responsibilities

- Load grants from the trusted `GrantSource`; put only the question in the
  message payload. A payload never supplies authority.
- Install a `GrantUsageStore` with atomic consumption. The example uses the
  in-memory implementation; production persistence belongs to the host.
- Match `AccessContext.authority` to the grant issuer and give each grant a unique
  ID within its namespace.
- Start each recipient's actual turn separately using that recipient's own
  grants. The example reply router echoes the recipient to isolate dispatch and
  correlation behavior; it does not execute a department model or file read.
- Issue a new ticket deliberately for a subsequent review. Do not silently
  replenish an exhausted grant in a retry loop.
- Open one authority lease per turn and close it on every exit path. A store
  edit made during a turn lands on the next one, which is why the revocation
  case opens its turn after revoking.
- Check the returned `status`, including `denied`, rather than relying on HTTP
  status alone when using the HTTP adapter.
