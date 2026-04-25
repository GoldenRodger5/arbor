# Pending Review Queue

Things deliberately deferred — review on the listed date. Each entry has a trigger condition; check it instead of just the date.

When closing an item, move it to **Closed** at the bottom (don't delete) so we have a record of what we decided.

---

## 2026-05-09 — Tier 2 calibration prompt rewrite

**Trigger:** MFE data has accumulated. Each (sport × phase × side × confidence-band) bucket has ≥20 real trades with `maxFavorableMove != null`.

**Why we're waiting:** Tier 1 (MFE tracking) shipped 2026-04-25. The calibration feedback already shows price-move WR alongside game WR once a bucket hits n≥20. Tier 2 is the *prescriptive* step — actually changing prompt language to tell Claude how to weight price-direction vs game-outcome calibration. We need data first to know whether the gap between the two is real and worth acting on.

**What to do at review:**

1. Run `curl -s "http://87.99.155.128:3456/api/calibration-stats?token=arbor-2026"` and look at price-move WR vs game-outcome WR per bucket.
2. Decide based on the gap:
   - **Gap ≥ +20pt (price-move higher):** Tier 2 is justified. Add prescriptive language to the calibration feedback prompt: "your price-direction reads are calibrated even when games flip — trust the entry, the exit handles the rest." Lowers Claude's tendency to over-trim confidence on game-outcome noise.
   - **Gap ≤ +10pt:** the reframe didn't add value. Close this item; document in STRATEGY_ROADMAP.md that the price-move metric exists but doesn't materially differ from game-outcome metric.
   - **Mixed by sport:** do per-sport prompt language — e.g., apply Tier 2 framing only on sports where the gap is large.
3. If we ship Tier 2, monitor for 2 weeks: did Claude get more aggressive on entries? Did P&L improve? Did stop-loss frequency change?

**Files to revisit:**
- [bot/ai-edge.mjs](bot/ai-edge.mjs) — `computeCalibrationFeedback()` around line 280-360 (the bucket verdict line is where Tier 2 language would slot in).
- [STRATEGY_ROADMAP.md](STRATEGY_ROADMAP.md) — log the decision.
- This file — move to Closed.

---

## Closed

(empty)
