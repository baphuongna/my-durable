# Local verification and release gates

Run from the repository root after installing the four apps:

```sh
just test verify              # full local matrix
just test verify P2           # core checks without lint/browser/PTY
node scripts/verify.mjs --phase all
node --test scripts/verify.test.mjs
```

Phase names are case-insensitive. A missing value after `--phase`, an unknown
phase, a failed check or a check that cannot run produces a nonzero exit.
Every command runs with an explicit working directory.

## What each command covers

All phases run the verification CLI regressions and five build/type/contract
checks. The CLI tests execute the real runner in an isolated filesystem and
replace only its external commands.

| Selector | Additional checks |
|---|---|
| `P0` | SDK tests (a focused selector, not a G0 decision) |
| `P1` | SDK and playground tests (not a G1 decision) |
| `P2` (default) | SDK, backend, playground and TUI tests |
| `all` | P2 plus the R-1/M4 SIGKILL recovery timing, both lint groups, the network/mobile browser, pairing/offline-credential browser and real PTY pairing/resize tests |

The Web build runs before browser tests. Lint/browser/PTY checks are **NOT_RUN**
in `P2`, not implicitly passed. `all` requires the installed playground lint
toolchain, system Chrome (`channel: "chrome"` in Playwright) and `tuistory`.
Core integration tests also need `tools/caddy`. Test providers are faux and
servers bind loopback; no paid-model or deployment commands run.

## Recovery timing (R-1/M4)

```sh
just test timing              # or: cd apps/dpi-backend && npm run test:timing
DPI_M4_REPORT=/path/m4.json npm run test:timing   # also keep the JSON report
```

This suite SIGKILLs a real device server mid-run and measures how long it takes
to be back at verified durable progress. Every sample is asserted **strictly
under 2 s**, measured from *before* the kill (the interval includes a fixed
kill-position wait, so it is an upper bound, not a stopwatch on the restart
alone). The runner prints every sample, including the ones before a failure.

It is a **this-machine** measurement and it is load-sensitive: run it on a
quiet machine, never in parallel with the rest of the matrix. On the reference
laptop (i5-6300HQ ×4, Node 22) quiet samples land around 1.0–1.4 s; background
load pushes individual samples up, so a failure under load is rerun on an idle
machine before it counts. A green run here is **not** the P2-29 M4 acceptance:
that target is defined over NAT with the current daemon and is measured
separately.

## Regression suites for the Gate A remediation

All run inside the phase suites above; each is also runnable on its own with
`npx tsx --test tests/<file>` from the owning app.

- `apps/dpi-backend`: `connector-backoff`, `connector-hardening`,
  `connector-limits`, `connector-tls`, `pairing-lifecycle`, `private-dir`,
  `rest-allowlist`, `token-script`, `timing/m4-resume.timing.ts`.
- `apps/dpi-playground`: `client-ip`, `http-errors`, `pairing-limits`,
  `audit`, `guards-audit`, `hub-errors`, `tunnel-gate-a`, `pairing-gate-a`,
  `device-lifecycle` (R-2 tunnel reconnect, T-2 bounded backoff), the
  `fe-*` client suites, and the GA-* cases appended to `rotation`,
  `rotation-ack`, `revoke` and `tls-policy`.
- `apps/dpi-sdk`: `registry-migration` with the `fixtures/registry-v0`
  builder, `registry-writers` (writer exclusion), `backoff`, `private-dir`,
  `sse-limits`.
- `apps/dpi-tui`: `pairing-ui.mjs` covers the offline-credential scan (S-7)
  in a real PTY.

The runner prints command/status/count/duration summaries and bounded failure
output. It does **not** automatically save a report or source manifest.
Capture output to a new local evidence file and keep the command's exit code;
do not pipe it through a command that hides failure. Evidence needs the Git HEAD
and hashes of uncommitted source, not just a commit name.

## What a green local run does not establish

- **P2-29:** real NAT pairing and current-daemon M1–M4 targets are
  **NOT_MEASURED**. M3 includes human fingerprint approval; M4 starts before
  SIGKILL and ends at verified durable resumed progress.
- **D-4 (P3):** the disaster restore/quarantine/re-pair drill is
  **NOT_MEASURED**. D-4 is not the NAT test.
- **Gate A / Gate B:** **NOT_EVALUATED**. A green runner is neither an independent
  security verdict nor owner authorization to expose or deploy anything.
- Soak/capacity, real-model/provider acceptance and untested platforms remain
  separate work. Historical records do not become current acceptance results.

## Memory units

The M1 contract is **150 MB = 150,000,000 bytes**, not 150 MiB.
Convert Linux `VmHWM` KiB to bytes by multiplying by 1024, then compare bytes
before rounding. Report both decimal MB and binary MiB.

The original P0 samples remain historical inputs. Their `targetMiB: 150` field
was incorrect contract metadata and must not determine the verdict. The first
sample is 153,256 KiB = 156,934,144 bytes, so that baseline misses M1 despite
rounding to 149.7 MiB. This correction is not a fresh P2 performance measurement.
