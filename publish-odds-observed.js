#!/usr/bin/env node
"use strict";

// Publishes the observed-odds transparency snapshot (public/odds/odds-observed.json)
// from the server-authoritative gacha_pull_audit collection.
//
// Keihyoho discipline: every number written here becomes a public factual claim.
// - Data source is the server audit trail (rarityCounts / hardPityFiveCount), never
//   client analytics.
// - A 3-sigma deviation between observed and published 5-star rate blocks publishing
//   until a human reviews and re-runs with --allow-sigma-alert (and files the review
//   in the ops log). Bad-but-within-noise weeks publish normally — that is the point
//   of the page.
// - Banners below the minimum sample stay listed as collecting (not silently dropped
//   from the pipeline, not published with meaningless rates).

const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_PROJECT = "lamplight-270e0";
const PUBLISHED_FIVE_RATE = 0.02; // OddsScreen/公示同源:5★ 基础概率
const MIN_SAMPLE_PULLS = 1000;    // 低于此样本只标 collecting,不公布比率
const SAFE_BANNER_ID = /^[A-Za-z0-9_-]{1,64}$/; // 页面用 innerHTML 渲染,白名单防注入

function usage() {
  return `Usage:
  node scripts/publish-odds-observed.js [options]

Options:
  --project PROJECT_ID     Firebase/GCP project. Default: ${DEFAULT_PROJECT}
  --out PATH               Output JSON path. Default: public/odds/odds-observed.json
  --allow-sigma-alert      Publish even when a banner deviates >3 sigma from the
                           published rate (requires prior human review; note the
                           review in the ops log).
  --dry-run                Print the snapshot to stdout without writing the file.
  --self-test              Run local aggregation tests without Firebase credentials.
  -h, --help               Show this help.

Authentication:
  Uses Firebase Admin SDK application default credentials (same as support-audit.js).

Cadence (operations spec 概率实测公开页):
  First publish at T+30 after launch, then every Monday 00:00 UTC, followed by
  'firebase deploy --only hosting'. See .github/workflows/odds-weekly.yml.`;
}

function parseArgs(argv) {
  const args = {
    project: process.env.PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT || DEFAULT_PROJECT,
    out: path.join(__dirname, "..", "public", "odds", "odds-observed.json"),
    allowSigmaAlert: false,
    dryRun: false,
    selfTest: false,
    help: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--project") args.project = argv[++i];
    else if (a === "--out") args.out = argv[++i];
    else if (a === "--allow-sigma-alert") args.allowSigmaAlert = true;
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--self-test") args.selfTest = true;
    else if (a === "-h" || a === "--help") args.help = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  return args;
}

function loadAdmin() {
  try {
    return require("firebase-admin");
  } catch (_) {
    return require(path.join("..", "functions", "node_modules", "firebase-admin"));
  }
}

// Pure aggregation over audit rows: [{bannerId, count, rarityCounts, hardPityFiveCount}]
function aggregate(rows) {
  const byBanner = new Map();
  for (const row of rows) {
    const id = typeof row.bannerId === "string" ? row.bannerId : "";
    if (!SAFE_BANNER_ID.test(id)) continue;
    const count = Number.isFinite(row.count) ? row.count : 0;
    if (count <= 0) continue;
    const rc = row.rarityCounts || {};
    const fives = Number.isFinite(rc["5"]) ? rc["5"]
      : Number.isFinite(rc[5]) ? rc[5] : 0;
    const pityFives = Number.isFinite(row.hardPityFiveCount) ? row.hardPityFiveCount : 0;
    const agg = byBanner.get(id) || {totalPulls: 0, fiveStars: 0, pityFives: 0};
    agg.totalPulls += count;
    agg.fiveStars += fives;
    agg.pityFives += pityFives;
    byBanner.set(id, agg);
  }

  const banners = [];
  const alerts = [];
  for (const [id, agg] of [...byBanner.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1)) {
    if (agg.totalPulls < MIN_SAMPLE_PULLS) {
      banners.push({banner_id: id, collecting: true, total_pulls: agg.totalPulls,
        observed_rate: 0, pity_share: 0});
      continue;
    }
    const observed = agg.fiveStars / agg.totalPulls;
    const pityShare = agg.fiveStars > 0 ? agg.pityFives / agg.fiveStars : 0;
    const sigma = Math.sqrt(
      PUBLISHED_FIVE_RATE * (1 - PUBLISHED_FIVE_RATE) / agg.totalPulls);
    const deviated = Math.abs(observed - PUBLISHED_FIVE_RATE) > 3 * sigma;
    if (deviated) alerts.push({banner_id: id, observed, sigma, total_pulls: agg.totalPulls});
    banners.push({
      banner_id: id,
      total_pulls: agg.totalPulls,
      observed_rate: Number(observed.toFixed(6)),
      pity_share: Number(pityShare.toFixed(6)),
      sigma_alert: deviated,
    });
  }
  return {banners, alerts};
}

function buildSnapshot(rows, nowIso) {
  const {banners, alerts} = aggregate(rows);
  const published = banners.filter((b) => !b.collecting);
  return {
    snapshot: {
      collecting: published.length === 0,
      note: "Server-measured gacha outcomes from the authoritative pull audit "
        + "trail. Published base 5-star rate: 2.00% (hard pity at 70). "
        + "Generated by scripts/publish-odds-observed.js — do NOT hand-edit.",
      snapshot_at: nowIso,
      banners: published,
    },
    alerts,
    collectingCount: banners.length - published.length,
  };
}

function selfTest() {
  const rows = [
    // banner A: 20,000 pulls, exactly published rate, half from pity
    ...Array.from({length: 200}, () => (
      {bannerId: "banner-a", count: 100, rarityCounts: {"5": 2}, hardPityFiveCount: 1})),
    // banner B: tiny sample, must stay collecting
    {bannerId: "banner-b", count: 10, rarityCounts: {"5": 1}, hardPityFiveCount: 0},
    // banner C: 10,000 pulls at 1% observed -> beyond 3 sigma, must alert
    ...Array.from({length: 100}, () => (
      {bannerId: "banner-c", count: 100, rarityCounts: {"5": 1}, hardPityFiveCount: 0})),
    // hostile banner id must be dropped entirely
    {bannerId: "<img src=x>", count: 5000, rarityCounts: {"5": 500}, hardPityFiveCount: 0},
  ];
  const {snapshot, alerts, collectingCount} = buildSnapshot(rows, "2026-01-01T00:00:00Z");
  const assert = (cond, msg) => { if (!cond) throw new Error(`self-test failed: ${msg}`); };

  const a = snapshot.banners.find((b) => b.banner_id === "banner-a");
  assert(a && a.total_pulls === 20000, "banner-a sample");
  assert(Math.abs(a.observed_rate - 0.02) < 1e-9, "banner-a observed rate");
  assert(Math.abs(a.pity_share - 0.5) < 1e-9, "banner-a pity share");
  assert(a.sigma_alert === false, "banner-a must not alert");

  assert(!snapshot.banners.some((b) => b.banner_id === "banner-b"),
    "banner-b must not publish below min sample");
  assert(collectingCount === 1, "one collecting banner expected");

  const c = snapshot.banners.find((b) => b.banner_id === "banner-c");
  assert(c && c.sigma_alert === true, "banner-c must carry sigma alert");
  assert(alerts.length === 1 && alerts[0].banner_id === "banner-c", "alert list");

  assert(!snapshot.banners.some((b) => b.banner_id.includes("<")),
    "hostile banner id must be dropped");
  assert(snapshot.collecting === false, "snapshot publishes when any banner qualifies");

  const empty = buildSnapshot([], "2026-01-01T00:00:00Z");
  assert(empty.snapshot.collecting === true, "empty rows stay collecting");

  console.log("self-test OK (aggregation, min-sample gate, 3-sigma alert, id filter)");
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) { console.log(usage()); return 0; }
  if (args.selfTest) { selfTest(); return 0; }

  const admin = loadAdmin();
  admin.initializeApp({projectId: args.project});
  const db = admin.firestore();

  const rows = [];
  // Trailing full history per banner (operations spec phase 1); stream to bound memory.
  const stream = db.collection("gacha_pull_audit")
    .select("bannerId", "count", "rarityCounts", "hardPityFiveCount")
    .stream();
  await new Promise((resolve, reject) => {
    stream.on("data", (doc) => rows.push(doc.data()));
    stream.on("end", resolve);
    stream.on("error", reject);
  });

  const {snapshot, alerts, collectingCount} = buildSnapshot(rows, new Date().toISOString());

  if (alerts.length > 0) {
    for (const a of alerts) {
      console.error(`SIGMA ALERT: ${a.banner_id} observed ${(a.observed * 100).toFixed(3)}% `
        + `over ${a.total_pulls} pulls deviates >3 sigma from published 2.00%.`);
    }
    if (!args.allowSigmaAlert) {
      console.error("Refusing to publish. Investigate first (rate bug vs. statistical "
        + "fluke), then re-run with --allow-sigma-alert and record the review.");
      return 2;
    }
    console.error("Publishing WITH sigma alert per --allow-sigma-alert (human-reviewed).");
  }
  if (collectingCount > 0) {
    console.error(`Note: ${collectingCount} banner(s) below ${MIN_SAMPLE_PULLS} pulls `
      + "kept in collecting state (not published).");
  }

  const json = JSON.stringify(snapshot, null, 2) + "\n";
  if (args.dryRun) { console.log(json); return 0; }
  fs.writeFileSync(args.out, json, "utf8");
  console.log(`Wrote ${args.out} (${snapshot.banners.length} banner(s), `
    + `snapshot_at ${snapshot.snapshot_at}).`);
  console.log("Next: firebase deploy --only hosting");
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => { console.error(err.message || err); process.exit(1); });
