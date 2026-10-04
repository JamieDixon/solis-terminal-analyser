# Solis terminal analyser

A small zero-dependency Node.js CLI for analysing a saved SolisCloud `inverterDay` response.

Save each day's API response as a `.json` file (e.g. `data/2026-10-01.json`). The `data/` folder is git-ignored because responses include inverter serials and site details.

## Requirements

Node.js 20+ is recommended. The tool only uses Node's built-in modules.

## Run

```bash
node solis-analyse.mjs data/2026-10-01.json
```

Show every normalised interval:

```bash
node solis-analyse.mjs data/2026-10-01.json --intervals
```

Show an approximate energy-flow breakdown and interval flow view:

```bash
node solis-analyse.mjs data/2026-10-01.json --flow
```

The `--flow` output deliberately compares the interval-derived totals with Solis' daily counters. Where the instantaneous readings do not reconcile, the difference
is shown as `Unallocated measurement balance` rather than being incorrectly labelled
as grid export/import.

Show only intervals that meet the conservative curtailment test:

```bash
node solis-analyse.mjs data/2026-10-01.json --curtailment
```

Machine-readable output:

```bash
node solis-analyse.mjs data/2026-10-01.json --json
```

## What it reports

- sample count and coverage period
- median sample interval and data gaps
- Solis `timeZone` values observed
- daily solar, battery, grid and home-load counters
- battery SOC and peak charge/discharge
- peak AC power
- calculated DC PV input from `uPvN × iPvN`
- battery-nearly-full periods
- a conservative possible-curtailment detector
- instantaneous balance diagnostics
- an approximate daily energy-flow breakdown (Solar → House/Battery/Grid, Battery → House/Grid, Grid → House/Battery)
- an interval-by-interval power-flow view plus a measurement-balance check

## Curtailment detection

The tool deliberately does **not** equate `batteryCapacitySoc >= 99` with curtailment. A battery can be at 99% while still accepting solar.

Instead, it calculates DC PV input by summing `uPv1 × iPv1` through `uPv32 × iPv32`. A record is flagged only when DC PV input is above 500 W and DC input exceeds reported AC output by more than both 100 W and 10%.

This is a diagnostic heuristic, not a meter-grade measurement of curtailed energy. It should be validated against several days of data, especially days where export is disabled and the battery genuinely reaches its charge limit.

## Field assumptions

- `timeStr` is used as the displayed Solis time.
- `time` is not used for analytics. Its offset from `timeStr` is checked on every record and reported under DATA CHECKS (7 hours ahead in the 2026-10-01 sample).
- `pac` is treated as watts. DATA CHECKS confirms this by comparing it with the DC PV estimate (a median ratio near 1 means watts), even though Solis's `pacStr` label says `kW`.
- Daily energy counters are reported exactly as supplied by Solis.
- The DC PV estimate is calculated from the PV voltage/current fields.
- `pSum` is negative when importing from the grid and positive when exporting.
- The balance residual is `pac + discharge − pSum − charge − house`. It is diagnostic only; Solis fields can be measured at different points in a hybrid system.
- If the file doesn't cover the whole local day, a "Partial day" warning is printed. Interval-based figures (flow, curtailment estimate) then cover only that period, while daily counters stay complete.
- `--json` can be combined with `--flow`, `--intervals` or `--curtailment` to include those sections in the JSON output.

The official Solis developer documentation identifies `pac` as power, `batteryPower` as battery power, `familyLoadPower` as home load power, and `pSum` as total grid active power. `inverterDay` returns these as time-series records. See https://developer.soliscloud.com/guide/data-access-user.html
