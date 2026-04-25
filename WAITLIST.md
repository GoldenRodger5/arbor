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

## 2026-05-15 — Recent-crash entry cool-off rule

**Trigger:** ≥5 trades have fired with `recentCrashContext != null` AND we have settled outcomes for them.

**Why we're waiting:** WHU/EVE 2026-04-25 — bot bought during a 80→50→65→84 recovery whipsaw (1.3 minutes after a 27¢/min cross-confirmed contra crash). EVE actually scored 2 minutes later. Trade ultimately netted +$2.16 because WHU scored 2-1 right before our profit-lock fired — likely lucky, not skillful. The ESPN-stale guard correctly fired during the crash but RELEASED 1 minute later when line-move reverted to confirming. The guard has no "cool-off" memory.

Hypothesis: trades placed within 90s of a ≥15¢/min cross-confirmed contra crash systematically underperform vs. trades without this tag, because the volatility predicts imminent scoring.

**What's been shipped (data-only):** trades now log `recentCrashContext: {velocity, ageSec, when}` when entered within 90s of a ≥15¢/min crash. Tag-only, no behavioral change. See `bot/ai-edge.mjs` near the live-edge `logTrade` call.

**What to do at review:**

1. Filter trades where `recentCrashContext != null`. Compute their P&L distribution and MFE distribution.
2. Compare to a same-period control: live-prediction trades without the tag.
3. Decision:
   - **Tagged trades clearly underperform** (e.g., median P&L < 0 vs control ~0): add the cool-off rule — 90s lockout on entry after a ≥15¢/min crash regardless of line-move state.
   - **Tagged trades match or beat control:** WHU was variance, not signal. Close this item; remove the tagging logic to clean up.
   - **Mixed signal:** narrow the threshold (e.g., velocity ≥20¢/min, ageSec ≤60) and re-test.

**Files to revisit:**
- [bot/ai-edge.mjs](bot/ai-edge.mjs) — live-edge `logTrade` call where `recentCrashContext` is computed; ESPN-stale guard at line ~4031.
- This file — move to Closed.

---

## Closed

(empty)
