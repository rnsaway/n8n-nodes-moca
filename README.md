# n8n-nodes-moca

An [n8n](https://n8n.io) community node for **MOCA** — the command server behind Blue Yonder / JDA / RedPrairie warehouse management systems.

It connects to a MOCA service over the `application/moca-xml` protocol and runs MOCA syntax commands, including MOCA **local syntax** (native SQL in square brackets), with credentials managed by n8n.

No runtime dependencies.

[Installation](#installation) · [Credentials](#credentials) · [Operations](#operations) · [Result shape](#result-shape) · [Status codes](#status-codes) · [Examples](#examples) · [How it works](#how-it-works)

## Installation

### Community nodes panel (self-hosted n8n)

1. Go to **Settings → Community Nodes**.
2. Select **Install**.
3. Enter `n8n-nodes-moca` and confirm that you understand the risks of installing community nodes.
4. Select **Install**.

To use the node as an AI Agent tool, the instance also needs:

```bash
N8N_COMMUNITY_PACKAGES_ALLOW_TOOL_USAGE=true
```

### Manual install

```bash
cd ~/.n8n
npm install n8n-nodes-moca
```

Restart n8n afterwards. For Docker, install into the mounted `.n8n` volume or bake it into a custom image:

```dockerfile
FROM n8nio/n8n
USER root
RUN cd /usr/local/lib/node_modules/n8n && npm install n8n-nodes-moca
USER node
```

## Credentials

Create a **MOCA API** credential:

| Field | Required | Description |
| --- | --- | --- |
| Service URL | yes | Full URL of the MOCA endpoint, e.g. `https://moca.example.com:4700/service` |
| User ID | yes | MOCA user, sent as the `USR_ID` environment variable |
| Password | yes | Password for that user |
| Warehouse ID | no | Sent as `WH_ID` with every command |
| Device | no | Sent as `DEVCOD` with every command |
| Locale | no | Sent as `LOCALE_ID`, e.g. `US_ENGLISH`. Leave empty to use the locale returned at login. |
| Ignore SSL Issues | no | Accept self-signed certificates |
| Request Timeout (Ms) | no | Defaults to 300000 |
| Reuse Session | no | Reuse a MOCA session across executions instead of logging in every time. On by default. |
| Session Max Age (Minutes) | no | How long a cached session may be reused. `0` reuses it until the server rejects it. Defaults to 30. |

The credential's **Test** button posts a real `login user` to the service URL, so it catches a
wrong address, an unreachable host and a certificate the instance will not accept. It cannot tell
a wrong password from a right one: MOCA answers a rejected login with HTTP 200 and reports the
failure inside the response document. To check the credentials themselves, run the node's
**Test Connection** operation, which reads that status and shows MOCA's own message.

Warehouse, Device and Locale are sent with every command and can be read back inside one as
[`@@` globals](#credential-values-in-a-command).

The password is only ever used for the login command. Every later command authenticates with the session key MOCA returns, and that session key never reaches workflow data.

## Operations

### Execute Command

Runs a MOCA syntax command and returns one item per result row.

```
list warehouses
```

```
list orders where ordnum = @ordnum
```

### Local syntax (native SQL)

MOCA local syntax is native SQL in square brackets, written inside an ordinary command. There is no separate operation for it — put the brackets in the command text:

```
[select ordnum, ordtyp from ord where wh_id = @wh_id]
```

Commands and SQL compose in one pipeline, which is the point of MOCA syntax. `@name` refers to a column produced by the previous step:

```
[select ship_id from shipment_line where ordnum = @ordnum]
|
list shipments where ship_id = @ship_id
```

> **A MOCA command and its underlying table are not the same thing.** Commands join in
> descriptions, localisation and related records, so they return columns the base table does not
> have. `list warehouses` returns `lngdsc`, `short_dsc` and `longdsc`; the `wh` table itself has
> none of them. Check the command output before assuming a column exists in SQL.

### Test Connection

Logs in and returns the session details (user, name, warehouse, locale). Useful as a health check at the top of a workflow, and it always contacts the server rather than reporting a cached session.

### Arguments

Rather than pasting expression results into the command text, add **Arguments**. They are published ahead of the command with a `publish data` clause and referenced with `@name`:

| Name | Value |
| --- | --- |
| `wh_id` | `{{ $json.warehouse }}` |

```
list warehouses where wh_id = @wh_id
```

is sent as

```
publish data
 where wh_id = 'WMD1'
|
list warehouses where wh_id = @wh_id
```

Single quotes inside values are doubled, so a value containing an apostrophe — `O'Brien`, or a
crafted string designed to close the literal early and append its own clause — cannot break out
of it. **Use this for anything arriving from a webhook or an AI agent**, rather than building the
command with expressions.

### Credential values in a command

Credential fields are sent as MOCA environment variables, so a command can read them directly
as `@@` globals. Nothing needs to be passed in:

```
list orders where wh_id = @@wh_id
```

```
[select ordnum from ord where wh_id = @@wh_id]
```

| Credential field | Sent as | Reference as |
| --- | --- | --- |
| User ID | `USR_ID` | `@@usr_id` |
| Warehouse ID | `WH_ID` | `@@wh_id` |
| Device | `DEVCOD` | `@@devcod` |
| Locale | `LOCALE_ID` | `@@locale_id` |
| *(session, managed by the node)* | `SESSION_KEY` | `@@session_key` |

The password is never sent as an environment variable; it is only used by the login command.

**`@@name` and `@name` are different things**, and mixing them up is the most common cause of a
confusing `511` error:

| | Source | Scope |
| --- | --- | --- |
| `@@name` | Credential, as an environment variable | The whole request, including after a `\|` |
| `@name` | A column published by the previous pipeline step, which is what **Arguments** generates | From that step onward |

So credential constants use `@@`, and per-execution values use Arguments and `@`:

```
[select ordnum from ord where wh_id = @@wh_id and ordnum = @ordnum]
```

Two things to watch:

- **Do not quote it.** `'@@wh_id'` is the literal string `@@wh_id`, not the warehouse — inside a
  SQL string literal it is just text.
- **An unset variable is `null`, not an error.** Leaving *Device* empty makes `@@devcod` null and
  the command still succeeds, so a misspelt name such as `@@wh_di` fails silently rather than
  loudly. If a filtered query returns no rows unexpectedly, check the spelling first.

### Options

| Option | Default | Description |
| --- | --- | --- |
| Autocommit | `true` | Whether MOCA commits when the command succeeds. Turning it off does **not** roll back — see [Transactions](#transactions). |
| Convert Numeric Columns | `false` | Convert columns the server reports as numeric into numbers. Off by default so identifiers such as `0042` keep their leading zeros. |
| Simplify | `true` | One item per row. Turn off to get a single item with `status`, `message`, `columns` and `rows`. |
| Treat Empty Result as Error | `false` | Whether MOCA status `510` (no rows found) should fail the node |

## Result shape

With **Simplify** on (the default), each result row becomes one n8n item.

- **Values are strings**, matching what MOCA sends, unless *Convert Numeric Columns* is on. Dates arrive in MOCA's own format, e.g. `20250429045411`.
- **Empty fields become `null`**, not empty strings.
- **Repeated column names get a numeric suffix.** MOCA joins can return the same column twice — `list warehouses` returns `is_purged` twice — so the second occurrence becomes `is_purged_2`. Without this the first value would be silently overwritten.
- **Nested result sets** become nested objects with their own `columns` and `rows`.
- **No rows** produces a single item with `status`, `message`, `command` and `rowCount: 0`, so downstream nodes can tell "nothing matched" from "never ran".

With **Simplify** off, one item is returned holding `status`, `message`, `command`, `rowCount`, `columns` (with each column's MOCA `type`) and `rows`.

## Status codes

| Status | Meaning | What the node does |
| --- | --- | --- |
| `0` | Success | Returns the rows |
| `510` | No rows found | Returns an empty result. Not an error unless *Treat Empty Result as Error* is on. |
| `523` | Session expired | Logs in again and retries once, transparently |
| anything else | Server or database error | Fails the node with MOCA's own `message`, e.g. `501 - Command (...) not found` or `511 - Invalid column name '...'.` |

## Examples

**Look up inventory from an incoming webhook**

Operation `Execute Command`, argument `prtnum` → `{{ $json.body.sku }}`:

```
list inventory where prtnum = @prtnum
```

**Read straight from the database**

```
[select ordnum, ordtyp, client_id
   from ord
  where wh_id = @wh_id]
```

**Chain SQL into a command**

```
[select ship_id from shipment_line where ordnum = @ordnum]
|
list shipments where ship_id = @ship_id
```

**Use it as an AI agent tool**

The node has `usableAsTool` enabled, so it can be attached to an AI Agent to let the agent query the WMS. Give the agent a MOCA user whose database grants are read-only — a system prompt telling it to avoid writes is not a security control.

### Running the local MOCA client (`msql`)

Community nodes are not allowed to spawn OS processes, so this package does not shell out. To run a command through the MOCA client installed on the n8n host, use n8n's built-in **Execute Command** node:

```bash
msql -c "list warehouses"
```

## How it works

Each command posts a `moca-request` document to the service URL with the `application/moca-xml` content type:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<moca-request autocommit="true">
  <environment>
    <var name="USR_ID" value="SUPER"/>
    <var name="SESSION_KEY" value="..."/>
    <var name="WH_ID" value="WMD1"/>
    <var name="LOCALE_ID" value="US_ENGLISH"/>
  </environment>
  <query>list warehouses</query>
</moca-request>
```

Those `var` entries are what a command reads as [`@@` globals](#credential-values-in-a-command).
Empty credential fields are omitted from the document entirely.

The XML is built and parsed in-package, so **n8n-nodes-moca has no runtime dependencies**.

### Session handling

Logging in costs a full round trip, so the session key is cached in memory and shared by every MOCA node in the n8n process, keyed by service URL, user and password. Changing any of those starts a new session.

The cache never has to be right, only usually right. A session the server has already dropped comes back as status 523, which triggers a fresh login and a retry, so a stale entry costs one extra round trip — exactly what happens with no cache at all. When several executions start at once against a cold cache they share a single login rather than one each.

Measured against a real MOCA server, three executions cost 4 HTTP round trips instead of 6, and five concurrent executions made one login instead of five.

Sessions are held **in memory only**. A session key is a live credential, so it is never written to workflow static data, which n8n persists to its database. It is also stripped from the Test Connection output.

Turn it off per credential with **Reuse Session** if a server needs a fresh login every time.

### Transactions

A session lasts for one node execution, so **a transaction cannot span two MOCA nodes**. Turning *Autocommit* off does not roll anything back either — the node sends no `commit` and no `rollback`, so an uncommitted write may hold database locks until the session ends, and nothing can reach back to commit it.

If you want a dry run, say so explicitly in the command:

```
[select ship_id from shipment_line where ordnum = @ordnum]
|
change shipment where ship_id = @ship_id and early_dlvdte = @expected_date
|
rollback
```

For write protection, use a MOCA user without write grants. That is the only control that holds.

## Compatibility

Tested against n8n's node API version 1 with `n8n-workflow` 2.x. Requires Node.js 20.19 or newer.

## Development

```bash
npm install       # add --ignore-scripts if you have no C++ toolchain
npm run lint
npm test
npm run build
npm run dev       # runs a local n8n with this node linked in
```

### Releasing

```bash
npm run release          # patch, e.g. 0.2.0 -> 0.2.1
npm run release:minor    # breaking or new operations
npm run release:major
```

Each one builds, lints, tests and verifies the package first, then bumps the version, commits,
tags and pushes. Pushing the tag is what triggers the GitHub Actions publish, so that single
command is the whole release. The tag carries no `v` prefix; that is set in `.npmrc` rather than
as a flag, because npm scripts run through `cmd.exe` on Windows where `''` is not quoting and
would end up inside the tag name.

`npm version` refuses to run with uncommitted changes, so commit first.

`npm run live-check` exercises the compiled transport against a real MOCA server — login, a command, local syntax, the no-rows path, an error path and argument binding. Configure it with `moca.local.json` (gitignored) or `MOCA_URL` / `MOCA_USER` / `MOCA_PASSWORD`. Passwords and session keys are masked in its output.

## Resources

- [n8n community nodes documentation](https://docs.n8n.io/integrations/community-nodes/)
- [mocanexion](https://github.com/chainreaktive/mocanexion) — the Python MOCA client this protocol implementation follows

## License

[MIT](LICENSE.md)
