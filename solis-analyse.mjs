#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';

const { values, positionals } = parseArgs({
  options: {
    json: { type: 'boolean' },
    intervals: { type: 'boolean' },
    curtailment: { type: 'boolean' },
    flow: { type: 'boolean' },
  },
  allowPositionals: true,
});

const file = positionals[0];
if (!file) {
  console.error('Usage: node solis-analyse.mjs <solis-response.json> [--intervals] [--curtailment] [--flow] [--json]');
  process.exit(1);
}

const num = v => typeof v === 'number' ? v : Number(v ?? 0);
const fmt = (n, dp = 1) => Number.isFinite(n) ? n.toFixed(dp) : '—';
const fmtKw = w => `${fmt(w / 1000, 2)} kW`;
const fmtKwh = kwh => `${fmt(kwh, 1)} kWh`;

function percentile(values, p) {
  const a = [...values].sort((x, y) => x - y);
  if (!a.length) return 0;
  const i = (a.length - 1) * p;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return lo === hi ? a[lo] : a[lo] + (a[hi] - a[lo]) * (i - lo);
}

function dcPvWatts(r) {
  let total = 0;
  for (let i = 1; i <= 32; i++) {
    total += num(r[`uPv${i}`]) * num(r[`iPv${i}`]);
  }
  return total;
}

const raw = await readFile(file, 'utf8');
const response = JSON.parse(raw);
if (!response?.data || !Array.isArray(response.data)) {
  throw new Error('Expected a Solis response containing a data array.');
}

const rows = response.data
  .filter(r => r && r.timeStr)
  .sort((a, b) => num(a.dataTimestamp) - num(b.dataTimestamp));

if (!rows.length) throw new Error('No data records found.');

const first = rows[0];
const last = rows.at(-1);
const timestamps = rows.map(r => num(r.dataTimestamp));
const gaps = timestamps.slice(1).map((t, i) => (t - timestamps[i]) / 60000);
const pv = rows.map(r => num(r.pac));
const battery = rows.map(r => num(r.batteryPower));
const load = rows.map(r => num(r.familyLoadPower));
const soc = rows.map(r => num(r.batteryCapacitySoc));
const grid = rows.map(r => num(r.pSum));
const dcPv = rows.map(dcPvWatts);

const maxBy = (arr, predicate = () => true) => {
  let best = null;
  for (let i = 0; i < rows.length; i++) {
    if (!predicate(rows[i], i)) continue;
    if (!best || arr[i] > arr[best.i]) best = { i, row: rows[i] };
  }
  return best;
};

const maxPv = maxBy(pv);
const maxDcPv = maxBy(dcPv);
const maxCharge = maxBy(battery, r => num(r.batteryPower) > 0);
const maxDischarge = rows.reduce((best, row, i) => {
  if (num(row.batteryPower) >= 0) return best;
  return !best || num(row.batteryPower) < num(best.row.batteryPower) ? { i, row } : best;
}, null);
const maxLoad = maxBy(load);

const counters = {
  solar: num(last.eToday),
  batteryCharge: num(last.batteryTodayChargeEnergy),
  batteryDischarge: num(last.batteryTodayDischargeEnergy),
  gridImport: num(last.gridPurchasedTodayEnergy),
  gridExport: num(last.gridSellTodayEnergy),
  homeLoad: num(last.homeLoadTodayEnergy),
};

const durationHours = (timestamps.at(-1) - timestamps[0]) / 3600000;
const medianGap = percentile(gaps, 0.5);
const missingOver7 = gaps.filter(g => g > 7).length;

// Minutes each reading represents: the gap to the next reading, capped at 10 so
// an outage is not credited as continuous power. The last reading uses the median.
const rowMinutes = timestamps.map((t, i) => i < timestamps.length - 1
  ? Math.min(10, Math.max(0, (timestamps[i + 1] - t) / 60000))
  : medianGap);

// The gap check above only sees gaps between readings, so separately check
// whether the file covers the whole local day.
const clockMinutes = s => {
  const [h, m, sec] = s.split(':').map(Number);
  return h * 60 + m + (sec || 0) / 60;
};
const coverage = {
  startsLateMinutes: clockMinutes(first.timeStr.slice(11)),
  endsEarlyMinutes: 24 * 60 - clockMinutes(last.timeStr.slice(11)),
};
coverage.incomplete = coverage.startsLateMinutes > 15 || coverage.endsEarlyMinutes > 15;

// Instantaneous diagnostic. Solis does not document a single guaranteed power-flow
// equation for every hybrid configuration, so this is deliberately diagnostic only.
const intervals = rows.map((r, i) => {
  const pac = num(r.pac);
  const bat = num(r.batteryPower);
  const house = num(r.familyLoadPower);
  const gridPower = num(r.pSum);
  const dc = dcPv[i];
  const charge = Math.max(0, bat);
  const discharge = Math.max(0, -bat);
  // pSum is negative when importing and positive when exporting, so -pSum is net
  // supply from the grid.
  const residual = pac + discharge - gridPower - charge - house;
  const dcAcLoss = dc - pac;
  const socValue = num(r.batteryCapacitySoc);

  // Stronger than simply saying "SOC >= 99": genuine curtailment needs the DC
  // array power to be materially above the inverter's AC output. We use a
  // conservative 10% + 100 W threshold to avoid calling normal conversion loss
  // curtailment.
  const likelyCurtailment = dc > 500 && dcAcLoss > Math.max(100, dc * 0.10);
  const batteryNearlyFull = socValue >= 99;

  return {
    time: r.timeStr,
    pvW: pac,
    dcPvW: dc,
    batteryW: bat,
    batterySoc: socValue,
    houseW: house,
    gridW: gridPower,
    residualW: residual,
    dcAcLossW: dcAcLoss,
    batteryNearlyFull,
    likelyCurtailment,
  };
});

const curtailmentRows = intervals.filter(x => x.likelyCurtailment);
const nearFullRows = intervals.filter(x => x.batteryNearlyFull);
const dcAcRatios = intervals.filter(x => x.dcPvW > 100).map(x => x.pvW / x.dcPvW);
const minDcAcRatio = dcAcRatios.length ? Math.min(...dcAcRatios) : null;

// Estimate interval energy only for diagnostics. The API already supplies daily
// counters, so these estimates are not used to replace Solis's energy totals.
let estimatedCurtailmentKwh = 0;
intervals.forEach((x, i) => {
  if (x.likelyCurtailment) estimatedCurtailmentKwh += Math.max(0, x.dcAcLossW) * rowMinutes[i] / 60000;
});

// Observed from the data rather than assumed. If pac were in kW it would be
// roughly 1/1000 of the DC power calculated from volts × amps.
const pacToDcRatio = dcAcRatios.length ? percentile(dcAcRatios, 0.5) : null;
const pacUnit = pacToDcRatio == null ? 'unknown (no daylight readings)'
  : pacToDcRatio > 0.5 && pacToDcRatio < 1.2 ? 'W'
  : pacToDcRatio > 0.0005 && pacToDcRatio < 0.0012 ? 'kW'
  : 'unknown';
const timeOffsetsHours = [...new Set(rows
  .filter(r => r.time && r.timeStr)
  .map(r => ((clockMinutes(r.time) - clockMinutes(r.timeStr.slice(11))) / 60 + 24) % 24)
  .map(h => Math.round(h * 100) / 100))];

function computeFlow() {
  // Approximate interval energy flows. Instantaneous power fields do not always
  // reconcile perfectly in hybrid systems, so the model explicitly tracks any
  // unallocated balance rather than silently turning it into grid export/import.
  const flowTotals = {
    solarToHouse: 0,
    solarToBattery: 0,
    solarToGrid: 0,
    batteryToHouse: 0,
    batteryToGrid: 0,
    gridToHouse: 0,
    gridToBattery: 0,
    unallocated: 0,
  };

  const flowRows = intervals.map((x, i) => {
    const minutes = rowMinutes[i];
    const hours = minutes / 60;

    const solar = Math.max(0, x.pvW) / 1000;
    const house = Math.max(0, x.houseW) / 1000;
    const charge = Math.max(0, x.batteryW) / 1000;
    const discharge = Math.max(0, -x.batteryW) / 1000;

    let solarToHouse = Math.min(solar, house);
    let remainingSolar = Math.max(0, solar - solarToHouse);
    let remainingHouse = Math.max(0, house - solarToHouse);
    let solarToBattery = 0;
    let batteryToHouse = 0;
    let gridToHouse = 0;
    let gridToBattery = 0;
    let solarToGrid = 0;
    let batteryToGrid = 0;
    let unallocated = 0;

    if (charge > 0) {
      solarToBattery = Math.min(remainingSolar, charge);
      remainingSolar -= solarToBattery;
      gridToBattery = Math.max(0, charge - solarToBattery);
    } else if (discharge > 0) {
      batteryToHouse = Math.min(discharge, remainingHouse);
      remainingHouse -= batteryToHouse;
      batteryToGrid = Math.max(0, discharge - batteryToHouse);
    }

    // Do not infer grid export unless Solis' daily export counter says export is
    // actually occurring. In the supplied dataset that counter is 0.0 kWh.
    // Instead, residual excess is reported as unallocated balance.
    gridToHouse = remainingHouse;
    if (remainingSolar > 0) {
      const allowExport = counters.gridExport > 0.001;
      if (allowExport) solarToGrid = remainingSolar;
      else unallocated += remainingSolar;
    }
    if (batteryToGrid > 0 && counters.gridExport <= 0.001) {
      unallocated += batteryToGrid;
      batteryToGrid = 0;
    }

    // A positive grid requirement can be an artefact of imperfectly aligned
    // measurements. Keep it visible as grid import, but compare the aggregate
    // against Solis' daily grid-import counter below.
    const energy = {
      solarToHouse: solarToHouse * hours,
      solarToBattery: solarToBattery * hours,
      solarToGrid: solarToGrid * hours,
      batteryToHouse: batteryToHouse * hours,
      batteryToGrid: batteryToGrid * hours,
      gridToHouse: gridToHouse * hours,
      gridToBattery: gridToBattery * hours,
      unallocated: unallocated * hours,
    };

    for (const [key, value] of Object.entries(energy)) flowTotals[key] += value;

    return { ...x, minutes, solarToHouse, solarToBattery, solarToGrid, batteryToHouse, batteryToGrid, gridToHouse, gridToBattery, unallocated };
  });

  const flowBalance = {
    solar: flowTotals.solarToHouse + flowTotals.solarToBattery + flowTotals.solarToGrid,
    batteryDischarge: flowTotals.batteryToHouse + flowTotals.batteryToGrid,
    gridImport: flowTotals.gridToHouse + flowTotals.gridToBattery,
    houseLoad: flowTotals.solarToHouse + flowTotals.batteryToHouse + flowTotals.gridToHouse,
    batteryCharge: flowTotals.solarToBattery + flowTotals.gridToBattery,
    gridExport: flowTotals.solarToGrid + flowTotals.batteryToGrid,
  };

  return { totals: flowTotals, modelTotals: flowBalance, intervals: flowRows };
}

const flow = values.flow ? computeFlow() : null;
const intervalList = values.curtailment ? curtailmentRows : values.intervals ? intervals : null;

const result = {
  records: rows.length,
  start: first.timeStr,
  end: last.timeStr,
  durationHours,
  medianIntervalMinutes: medianGap,
  gapsOver7Minutes: missingOver7,
  coverage,
  solisTimeZones: [...new Set(rows.map(r => r.timeZone))],
  startSoc: soc[0],
  endSoc: soc.at(-1),
  minSoc: Math.min(...soc),
  maxSoc: Math.max(...soc),
  peakPvW: num(maxPv.row.pac),
  peakPvAt: maxPv.row.timeStr,
  peakDcPvW: dcPv[maxDcPv.i],
  peakDcPvAt: maxDcPv.row.timeStr,
  peakBatteryChargeW: maxCharge ? num(maxCharge.row.batteryPower) : 0,
  peakBatteryChargeAt: maxCharge?.row.timeStr ?? null,
  peakBatteryDischargeW: maxDischarge ? num(maxDischarge.row.batteryPower) : 0,
  peakBatteryDischargeAt: maxDischarge?.row.timeStr ?? null,
  peakHouseLoadW: num(maxLoad.row.familyLoadPower),
  peakHouseLoadAt: maxLoad.row.timeStr,
  counters,
  curtailment: {
    likelyIntervals: curtailmentRows.length,
    batteryNearlyFullIntervals: nearFullRows.length,
    estimatedKwh: estimatedCurtailmentKwh,
    minimumDcToAcRatio: minDcAcRatio,
    conclusion: curtailmentRows.length
      ? 'Possible curtailment detected; inspect intervals before treating the estimate as energy lost.'
      : 'No strong PV-curtailment signature detected in this dataset.',
  },
  dataQuality: {
    pacUnit,
    pacUnitLabel: first.pacStr ?? null,
    medianPacToDcRatio: pacToDcRatio,
    dcPvCalculation: 'sum(uPvN × iPvN) across 32 inputs, in watts.',
    timeOffsetsHours,
    balanceEquation: 'pac + discharge - pSum - charge - house (pSum < 0 = import)',
    medianBalanceResidualW: percentile(intervals.map(x => Math.abs(x.residualW)), 0.5),
    maxBalanceResidualW: Math.max(...intervals.map(x => Math.abs(x.residualW))),
  },
};

if (flow) result.flow = flow;
if (intervalList) result.intervals = intervalList;

if (values.json) {
  console.log(JSON.stringify(result, null, 2));
} else {
  printReport();
}

function printReport() {
  console.log(`\nSolis day: ${first.timeStr.slice(0, 10)}\n`);
  console.log(`  Records             ${result.records}`);
  console.log(`  Period              ${result.start} → ${result.end}`);
  console.log(`  Duration            ${fmt(result.durationHours, 2)} h`);
  console.log(`  Median interval     ${fmt(result.medianIntervalMinutes, 2)} min`);
  console.log(`  Gaps > 7 min        ${result.gapsOver7Minutes}`);
  if (coverage.incomplete) {
    const missing = [
      coverage.startsLateMinutes > 15 && `first ${fmt(coverage.startsLateMinutes / 60, 1)} h`,
      coverage.endsEarlyMinutes > 15 && `last ${fmt(coverage.endsEarlyMinutes / 60, 1)} h`,
    ].filter(Boolean).join(' and ');
    console.log(`  ⚠ Partial day       missing the ${missing}; daily counters are still`);
    console.log(`                      complete, but interval-based figures are not.`);
  }
  console.log(`  Solis timeZone      ${result.solisTimeZones.join(', ')}`);

  console.log('\nENERGY');
  console.log(`  Solar generation    ${fmtKwh(counters.solar)}`);
  console.log(`  Battery charge      ${fmtKwh(counters.batteryCharge)}`);
  console.log(`  Battery discharge   ${fmtKwh(counters.batteryDischarge)}`);
  console.log(`  Grid import         ${fmtKwh(counters.gridImport)}`);
  console.log(`  Grid export         ${fmtKwh(counters.gridExport)}`);
  console.log(`  Home load           ${fmtKwh(counters.homeLoad)}`);

  console.log('\nBATTERY');
  console.log(`  SOC                 ${result.startSoc}% → ${result.endSoc}%`);
  console.log(`  SOC range           ${result.minSoc}% → ${result.maxSoc}%`);
  console.log(`  Peak charge         ${fmtKw(result.peakBatteryChargeW)} @ ${result.peakBatteryChargeAt}`);
  console.log(`  Peak discharge      ${fmtKw(Math.abs(result.peakBatteryDischargeW))} @ ${result.peakBatteryDischargeAt}`);

  console.log('\nPOWER');
  console.log(`  Peak PV (AC)        ${fmtKw(result.peakPvW)} @ ${result.peakPvAt}`);
  console.log(`  Peak PV (DC calc)   ${fmtKw(result.peakDcPvW)} @ ${result.peakDcPvAt}`);
  console.log(`  Peak house load     ${fmtKw(result.peakHouseLoadW)} @ ${result.peakHouseLoadAt}`);

  console.log('\nSOLAR / CURTAILMENT');
  console.log(`  Battery ≥99%        ${result.curtailment.batteryNearlyFullIntervals} intervals`);
  console.log(`  Likely curtailment  ${result.curtailment.likelyIntervals} intervals`);
  console.log(`  Est. curtailed      ${fmtKwh(result.curtailment.estimatedKwh)}`);
  console.log(`  Min DC→AC ratio     ${result.curtailment.minimumDcToAcRatio == null ? '—' : fmt(result.curtailment.minimumDcToAcRatio * 100, 1) + '%'}`);
  console.log(`  Conclusion          ${result.curtailment.conclusion}`);

  const dq = result.dataQuality;
  const fmtOffset = h => `${h >= 0 ? '+' : ''}${h}h`;
  console.log('\nDATA CHECKS');
  console.log(`  pac unit            ${dq.pacUnit}${dq.medianPacToDcRatio == null ? '' : ` (median AC/DC ${fmt(dq.medianPacToDcRatio, 3)})`}${dq.pacUnitLabel && dq.pacUnitLabel !== dq.pacUnit ? `; Solis labels it "${dq.pacUnitLabel}"` : ''}`);
  console.log(`  time vs timeStr     ${!dq.timeOffsetsHours.length ? 'no time field'
    : dq.timeOffsetsHours.length === 1 ? `time is ${fmtOffset(dq.timeOffsetsHours[0])} throughout`
    : `inconsistent offsets: ${dq.timeOffsetsHours.map(fmtOffset).join(', ')}`}`);
  console.log(`  Median balance residual ${fmt(result.dataQuality.medianBalanceResidualW, 0)} W`);
  console.log(`  Max balance residual    ${fmt(result.dataQuality.maxBalanceResidualW, 0)} W`);
  console.log('\nNote: curtailment detection is deliberately conservative. Battery-at-99% alone is not treated as curtailment.');

  if (values.flow) {
    const { totals: flowTotals, modelTotals: flowBalance, intervals: flowRows } = flow;

    console.log('\nENERGY FLOW (APPROX.)');
    console.log('  Derived from interval power readings. Solis daily counters are authoritative.');
    console.log('  Any measurement mismatch is kept as "Unallocated" rather than being');
    console.log('  incorrectly labelled as grid export/import.');
    console.log('');
    console.log('  SOURCE → DESTINATION                 kWh');
    console.log(`  Solar → House                     ${fmtKwh(flowTotals.solarToHouse)}`);
    console.log(`  Solar → Battery                   ${fmtKwh(flowTotals.solarToBattery)}`);
    console.log(`  Solar → Grid                      ${fmtKwh(flowTotals.solarToGrid)}`);
    console.log(`  Battery → House                   ${fmtKwh(flowTotals.batteryToHouse)}`);
    console.log(`  Battery → Grid                    ${fmtKwh(flowTotals.batteryToGrid)}`);
    console.log(`  Grid → House                      ${fmtKwh(flowTotals.gridToHouse)}`);
    console.log(`  Grid → Battery                    ${fmtKwh(flowTotals.gridToBattery)}`);
    console.log(`  Unallocated measurement balance   ${fmtKwh(flowTotals.unallocated)}`);

    console.log('\n  DAILY COUNTER COMPARISON');
    console.log(`  Solis solar generation            ${fmtKwh(counters.solar)}`);
    console.log(`  Flow-model solar                  ${fmtKwh(flowBalance.solar)}`);
    console.log(`  Solis battery charge              ${fmtKwh(counters.batteryCharge)}`);
    console.log(`  Flow-model battery charge         ${fmtKwh(flowBalance.batteryCharge)}`);
    console.log(`  Solis battery discharge           ${fmtKwh(counters.batteryDischarge)}`);
    console.log(`  Flow-model battery discharge      ${fmtKwh(flowBalance.batteryDischarge)}`);
    console.log(`  Solis grid import                 ${fmtKwh(counters.gridImport)}`);
    console.log(`  Flow-model grid import            ${fmtKwh(flowBalance.gridImport)}`);
    console.log(`  Solis grid export                 ${fmtKwh(counters.gridExport)}`);
    console.log(`  Flow-model grid export            ${fmtKwh(flowBalance.gridExport)}`);
    console.log(`  Solis home load                   ${fmtKwh(counters.homeLoad)}`);
    console.log(`  Flow-model home load              ${fmtKwh(flowBalance.houseLoad)}`);

    console.log('\n  INTERVAL FLOW');
    for (const x of flowRows) {
      const significant = [x.solarToHouse, x.solarToBattery, x.solarToGrid, x.batteryToHouse, x.batteryToGrid, x.gridToHouse, x.gridToBattery, x.unallocated]
        .some(v => v >= 0.05);
      if (!significant) continue;

      const time = x.time.slice(11, 16);
      const solar = Math.max(0, x.pvW) / 1000;
      console.log(`  ${time}  Solar ${fmt(solar,2)} kW`);
      if (x.solarToHouse >= 0.05) console.log(`         ├─ House   ${fmt(x.solarToHouse,2)} kW`);
      if (x.solarToBattery >= 0.05) console.log(`         ├─ Battery ${fmt(x.solarToBattery,2)} kW  (charging)`);
      if (x.batteryToHouse >= 0.05) console.log(`         ├─ Battery ${fmt(x.batteryToHouse,2)} kW  → house`);
      if (x.gridToHouse >= 0.05) console.log(`         ├─ Grid    ${fmt(x.gridToHouse,2)} kW  (import)`);
      if (x.gridToBattery >= 0.05) console.log(`         ├─ Grid    ${fmt(x.gridToBattery,2)} kW  → battery`);
      if (x.solarToGrid >= 0.05) console.log(`         ├─ Grid    ${fmt(x.solarToGrid,2)} kW  (export)`);
      if (x.batteryToGrid >= 0.05) console.log(`         ├─ Grid    ${fmt(x.batteryToGrid,2)} kW  (battery export)`);
      if (x.unallocated >= 0.05) console.log(`         └─ Unallocated ${fmt(x.unallocated,2)} kW`);
    }
  }

  if (intervalList) {
    const list = intervalList;
    console.log('\nINTERVALS');
    if (!list.length) {
      console.log('  No matching intervals.');
    } else {
      console.log('  Time                 PV AC   PV DC   Battery    SOC   Load   Grid   Residual');
      for (const x of list) {
        console.log(`  ${x.time}  ${fmt(x.pvW/1000,2).padStart(6)}  ${fmt(x.dcPvW/1000,2).padStart(6)}  ${fmt(x.batteryW/1000,2).padStart(8)}  ${String(x.batterySoc).padStart(4)}%  ${fmt(x.houseW/1000,2).padStart(6)}  ${fmt(x.gridW/1000,2).padStart(6)}  ${fmt(x.residualW).padStart(8)}`);
      }
    }
  }
}
