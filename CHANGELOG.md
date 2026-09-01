# Changelog

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
