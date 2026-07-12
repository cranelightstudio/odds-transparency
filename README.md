# Leave a Light On — Observed Gacha Odds: Methodology

This repository publishes the exact aggregation code behind the public
observed-odds page for *Leave a Light On* (『留灯』):

**https://cranelightstudio.com/odds/**

『留灯』の提供割合実測ページで使っている集計コードを、そのまま公開しています。
本仓库公开《留灯》概率实测页所使用的聚合代码原文。

## What the page shows

- Published 5★ rate: **2.00% base / 2.64% effective with hard pity at 70**
  (no off-banner — the featured card is guaranteed at pity).
- The page shows **server-measured** values per banner: observed 5★ rate,
  the share of 5★s delivered by pity, and the sample size (total pulls).
- Updated **every Monday 00:00 UTC**. Bad weeks get published too.

## Where the numbers come from

The data source is the **server-authoritative pull audit trail**
(`gacha_pull_audit`): every pull is recorded atomically by the game server
at execution time (`count`, `rarityCounts`, `hardPityFiveCount`).
Client-side analytics events are **not** used — the client cannot influence
the audit trail that this page is computed from.

[`publish-odds-observed.js`](./publish-odds-observed.js) is the complete
pipeline, byte-for-byte identical to the file we run in production:

1. Streams the full audit history per banner.
2. Aggregates with a pure function (`aggregate()`).
3. Applies two guards before anything is published:
   - **Minimum sample**: banners under 1,000 recorded pulls stay in
     "collecting" state — no meaningless rates.
   - **3σ gate**: if a banner's observed 5★ rate deviates from the published
     2.00% by more than three binomial standard deviations, publishing is
     **blocked** until a human investigates (a rate bug must never become a
     "fake odds" incident). The reviewed override is explicit and logged.
4. Writes `odds-observed.json`, served at
   https://cranelightstudio.com/odds/odds-observed.json — every published
   figure is a public factual claim; the file is never hand-edited.

## Verify it yourself

The aggregation, minimum-sample gate, 3σ gate and banner-id filtering are
covered by an offline self-test that needs no credentials:

```
node publish-odds-observed.js --self-test
```

Observed values wobbling around the published rate is the normal behavior of
probability. What this repository lets you check is that the wobble is
measured honestly.

## Contact

support@cranelightstudio.com · https://cranelightstudio.com/
