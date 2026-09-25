# Changelog

## Unreleased

- Logins (including the credential **Test** button) are now sent with `autocommit="true"`.
  With `autocommit="false"` the MOCA server neither commits nor rolls back, and leaves the
  login transaction open on a pooled database connection until an unrelated request reuses it.
- The **Autocommit** option description now says what turning it off actually does: an
  uncommitted write keeps its locks on a pooled connection until a later, unrelated request
  commits it.

## 0.2.5

Initial release.

An n8n community node for MOCA, the command server behind Blue Yonder / JDA / RedPrairie
warehouse management systems. It connects over the `application/moca-xml` protocol and runs
MOCA syntax commands, including local syntax (native SQL in square brackets), with credentials
managed by n8n.

- `Execute Command` runs any MOCA command and returns one item per result row.
- `Test Connection` performs a real login and reports the session details.
- Arguments are bound through a `publish data` clause rather than concatenated into the
  command, so values from a webhook or an AI agent cannot break out of a string literal.
- Credential fields are sent as MOCA environment variables and can be read in a command as
  `@@` globals.
- The session is cached in memory and shared across executions, with an expired session
  detected and replaced automatically.
- Usable as an AI Agent tool.
- No runtime dependencies.
