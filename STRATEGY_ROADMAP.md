# Arbor Strategy Roadmap & Audit

**Living document.** Update after every audit, strategy change, or data review. Last audit: 2026-04-23.

---

## TL;DR — where we stand

- **100 settled trades, +$154 P&L** — but 4 outlier games carried +$371. **Without them: −$160 across 94 trades.**
- Entry edge detection works (64% pick rate). The bleed is in exits and strategy-level R/R.
- Today's fixes (2026-04-23) addressed ~$275 of the $558 historical BAD-stop damage. Residual BAD patterns and structural issues below.
- Drawsbet = genuine edge. Live-swing = mathematically broken. Pre-game MLB ERA strategy = barely breakeven even on winners.

---

## 1. Strategy scorecard

| Strategy | N | WR | Avg W | Avg L | Net | State |
|---|---|---|---|---|---|---|
| `draw-bet` | 6 | 83% | +$44 | −$11 | **+$207** | ⭐ Golden; tiny sample, 1 game cluster (TOT-BRI) |
| `live-prediction` | 51 | 53% | +$8 | −$9 | +$16 | 🟡 Barely profitable; late-game stops bleed |
| `pre-game-prediction` | 35 | 41% | +$17 | −$13 | −$35 | 🔴 Losing despite decent avg-win |
| `pre-game-edge-first` | 8 | 25% | +$3 | −$7 | −$29 | 🔴 MLB FROZEN (confirmed losing) |
| `live-swing` | 5 | 20% | +$1.68 | −$5 | −$14 | 🔴 R/R broken by design (+12¢ / −10¢) |
| `comeback-buy` | 2 | 0% | — | — | $0 | ⚪ Too small |

---

## 2. Prompt inventory (17 total)

### Entry (6 Sonnet/WithSearch + 3 conditional)
| Category | Status |
|---|---|
| `pre-game` | 🟡 Over-weights ERA gaps; retune framing |
| `live-edge` / `live-edge-search` | 🟢 Solid — steel-man gate works |
| `pg-guard` | 🟢 Thesis-aware playoff-tuned, keep |
| `pg-win` | 🟢 Rarely fires, OK |
| `draw-bet` | 🟢 Works, keep lean |
| `comeback-buy` | ⚪ Too few trades to judge |
| `xval` | ⚪ Conditional trigger, low volume |
| `broad-scan` | ⚪ Low volume |
| `kalshi-decide` | ⚪ Legacy-adjacent |

### Exit (11 Haiku/claudeScreen)
| Category | Status | Memo-gated? |
|---|---|---|
| `exit:profit-lock` | 🟢 Good, holds winners | ❌ (intentional — profit semantics differ) |
| `exit:hc-lock` | 🟢 OK | ❌ |
| `exit:swing-stop` | 🟡 Fires on tied games too fast | ✅ |
| `exit:hard-stop` | 🟢 Threshold widened 12¢→25¢ 4/23 | ✅ |
| `exit:nuclear` | 🟢 Deep-drawdown hold shipped 4/23 | ✅ |
| `exit:we-reversal` | 🟢 Pre-game MLB inn1-4 suppressed 4/23 | ✅ |
| `exit:we-drop` | 🟢 Mostly fine | ✅ |
| `exit:loss-check` (tier-2) | 🟢 WE gate shipped 4/23 | ✅ |
| `exit:screen` | ⚪ Infra, not decision | — |
| `exit:broad-scan-screen` | ⚪ Infra | — |
| `exit:kalshi-sell` | ⚪ Legacy | — |

---

## 3. Exit mechanism stack (18 conditions, in firing order)

1. Contra line-move exit (mechanical)
2. Soccer 70-min hard exit
3. Swing profit-lock +12¢
4. Pre-game profit-lock (conf-anchored)
5. Draw-bet profit-lock +12¢
6. Live profit-lock +15¢ (Claude-gated)
7. High-conviction profit-lock (Claude-gated)
8. Swing hard-stop −10¢ / −6¢ contra (Claude-gated)
9. Swing thesis-expiry
10. Comeback profit-lock / thesis-broken
11. Pre-game news-exit (soccer-guarded)
12. Partial profit-take (late stage, 25%)
13. Pre-game hard-stop cent-based (Claude-gated, 25¢)
14. Pre-game nuclear eval (Claude-gated, deep-drawdown hold)
15. Mechanical nuclear floor (sport-aware, claude-hold widens)
16. WE-reversal (Claude-gated, pre-game MLB inn1-4 suppressed)
17. WE-drop
18. Tier-2 Claude catch-all (WE gate)

**Observation: 18 is too many.** Target consolidation to 8-10 in Phase 3.

---

## 4. Findings — issues ranked by dollar impact

### 🔴 CRITICAL — actively bleeding

| # | Issue | Evidence | $ Impact |
|---|---|---|---|
| C1 | Late-inning 1-run MLB live-prediction leads | 11 trades, 36% WR | **−$19 net** |
| C2 | MLB pre-game ERA-gap trades | 21 MLB pre-game losses / 45 total; avg L 2.6× avg W | **−$125** |
| C3 | Pre-game-prediction oversized bets | Biggest losses $33/$32/$23 all 60-85 contracts | **~$100** |
| C4 | Under-40¢ live-prediction entries | 0/4 WR, old entries pre-floor | **−$33** |

### 🟡 MODERATE

| # | Issue | Evidence | Impact |
|---|---|---|---|
| M1 | Loser/winner R/R on pre-game | Avg L $21 vs avg W $8 (2.6×) | Systemic |
| M2 | Live-swing mathematically broken | +12¢ exit / −10¢ stop = needs 46% WR to breakeven; current 20% | Structural |
| M3 | Profit subsidized by 4 outlier games | TOT-BRI $207, STL-HOU $82, ELC-ATM $40, DEN-SAS $42 | Fragility |
| M4 | No time-of-day / day-of-week analysis | No logging | Blind spot |

### 🔵 PROMPT-LEVEL

| # | Issue | File/line |
|---|---|---|
| P1 | MLB prompt: "Pitching is the DOMINANT driver" frames obvious edges as real | [ai-edge.mjs:5601](bot/ai-edge.mjs#L5601) |
| P2 | Soccer prompt: "A draw only hurts if still holding" — false | [ai-edge.mjs:5656](bot/ai-edge.mjs#L5656) |
| P3 | Live-edge late-game 3pt threshold is too loose | [ai-edge.mjs:4046](bot/ai-edge.mjs#L4046) |
| P4 | No prompt includes recent W/L feedback | `getCalibrationFeedback` exists but is bucket-based |
| P5 | Claude writes + defeats its own steel-man (self-serving) | [ai-edge.mjs:4061-4076](bot/ai-edge.mjs#L4061-L4076) |

### 🟣 STRUCTURAL RISKS

| # | Issue | Why it matters |
|---|---|---|
| S1 | 100 trades is thin for per-sport calibration | Need 200+ per bucket |
| S2 | Draw-bet cluster could regime-change | Kalshi pricing could tighten; our subsidy evaporates |
| S3 | Cross-sport city collisions | DAL-MIN had NHL + MLS on 4/23 |
| S4 | No pitcher mid-game re-eval | Starter blow-up invisible to exits until −20% |
| S5 | No bullpen-state awareness | C1 root cause |
| S6 | Edge-first only frozen for MLB | NBA/NHL/Soccer edge-first unvalidated |
| S7 | No regression tests for 18 exit paths | Silent bug risk |
| S8 | Claude training cutoff Jan 2026; early-season MLB ERA noisy | Data stale |

---

## 5. Implementation roadmap (phased)

### Phase 0 — Already shipped (2026-04-23)
- [x] Live-edge line-move promotion (`f541def`)
- [x] Period-aware SWING_WE_FLOOR + team-quality haircut (`c920dfb`)
- [x] Contra-velocity escalation on swing stops (`bb2be29`)
- [x] Nuclear respects Claude HOLD + cross-sport guard (`0b30e28`)
- [x] Sport-aware nuclear (NHL P1-P2, NBA Q1-Q2) (`0a6bfff`)
- [x] Claude-hold memo (no prompt overlap) (`15060a8`)
- [x] Tier-2 WE gate + deep-drawdown hold + BAD STOP tags (`714b813`)
- [x] Pre-game news-exit soccer guard + TIE in soccer prompt + 10min re-entry (`d22953a`)
- [x] Pre-game hard-stop 12¢→25¢ + WE-reversal pre-game MLB inn1-4 suppress (`b909874`)

### Phase 1 — Immediate wins (data-backed, high confidence) ✅ SHIPPED 2026-04-23

**Goal: kill the known bleeding patterns.**

- [x] **P1.1 — Block late-inning 1-run MLB live-prediction entries** (C1)
  - Shipped: `!isSwingMode && league === 'mlb' && stage === 'late' && abs(diff) ≤ 1 && targetAbbr === leadingAbbr` → reject
  - Commit: Phase 1 batch
  - Expected impact: +$19 over last sample, forward ~$5-10/week savings
  
- [x] **P1.2 — Raise MLB pre-game ERA threshold** (C2)
  - Shipped: opponent ERA > 5.5 OR both-extreme (your ace <2.5 vs opp >5.5) required for 66%+
  - Prompt reframed: "The market has already priced ERA gaps — find mispriced situations"
  - Historical 8-16 bucket explicitly called out; thin-edge rejection added
  - Expected: cut trade volume ~50%, raise WR toward 55%
  
- [x] **P1.3 — Cap pre-game per-trade risk at 5% of bankroll** (C3)
  - Shipped: `PRE_GAME_TRADE_FRACTION` 0.15 → 0.05; small-bankroll tiers cut to 6%/8%
  - `getDynamicMaxTrade` now accepts `strategy` arg and caps pre-game at 5%
  
- [x] **P1.4 — Verify under-40¢ live-prediction floor enforcement** (C4)
  - Verified: no under-40¢ entries since 2026-04-15. Existing `price < 0.50` block works.

### Phase 2 — Strategy-level fixes (needs thought)

**Goal: fix structurally broken strategies or drop them.**

- [ ] **P2.1 — Live-swing decision**
  - Option A: raise exit target to +20¢ (more runway)
  - Option B: raise entry confidence to 72% (less volume, higher quality)
  - Option C: drop live-swing, redirect edge-first cases to standard live-prediction
  - Requires: 2-week paper test of Option A vs B
  
- [ ] **P2.2 — Pre-game prompt reframe**
  - Rewrite the "pitching is dominant driver" line
  - Add explicit "the market has priced it unless you have a testable mispricing reason"
  - New section: "before you pick, list ONE specific reason the market has mispriced THIS game"
  
- [x] **P2.3 — Bullpen state surfaced in late-game exit prompts** ✅ 2026-04-23
  - Shipped: MLB 6th+ inning hard-stop eval now fetches both bullpens via MLB Stats API
  - Prompt annotated with tier/ERA + LEADING/TRAILING framing
  - Attacks the C1 pattern root cause (bullpen-collapse risk unmodeled)
  
- [ ] **P2.4 — Pitcher mid-game re-eval**
  - If starter pulled / line of 4+ ER / surrendered 3+ runs in <2 IP → trigger eval
  - Thesis-break exit if the pitching edge is now inverted

### Phase 3 — Structural improvements

**Goal: reduce complexity, add learning loops.**

- [ ] **P3.1 — Exit-condition consolidation (18 → 8-10)**
  - Merge WE-reversal + WE-drop into one path
  - Merge swing-hard-stop + pg-hard-stop into one (sport/strategy parameterized)
  - Unified "exit decision function" with priority ordering
  
- [ ] **P3.2 — Stop-review auto-calibration**
  - Wilson CI on BAD-stop rate per (sport, stop-type)
  - Auto-loosen threshold by 2pt if BAD rate > 40% on 20+ samples
  - Auto-tighten if GOOD rate > 80%
  - Surfaces calibration suggestions to Telegram, not auto-applies
  
- [x] **P3.3 — Time-of-day / day-of-week logging** ✅ 2026-04-23 (data plumbing only)
  - Shipped: `etHour`, `dayPart` (morning/afternoon/evening/night), `dayOfWeek` on every trade
  - Still TODO: run WR analysis once we have 100+ new trades with these fields
  
- [ ] **P3.4 — Recent W/L feedback in entry prompts**
  - Top-line: "You're 3-0 / 2-8 / 5-5 on recent MLB pre-game"
  - Deters continuing a losing streak on similar bets
  
- [ ] **P3.5 — 2nd-Claude critique pass for high-conviction entries**
  - For any entry at 68%+ confidence or $20+ deploy, run separate Claude call with system prompt "critique this thesis — find the hole"
  - Block trade if critique names a specific missing fact

### Phase 4 — New strategies / expansion

**Goal: more golden edges like draw-bet.**

- [ ] **P4.1 — Draw-bet expansion**
  - Currently limited; expand to La Liga, Serie A, Bundesliga (EPL works)
  - Cap exposure per-game to avoid TOT-BRI single-game concentration
  
- [ ] **P4.2 — Late-game underdog tail bets (structural inverse of C1)**
  - If market prices 30¢ for 1-run deficit in 7th and bullpen is weak → BUY trailing team
  - This is the other side of the C1 pattern we just blocked
  
- [ ] **P4.3 — NBA Q4 comeback identification**
  - Comparable to `comeback-buy` but NBA-specific; pace-adjusted
  - Small initial position sizing, paper-test first
  
- [ ] **P4.4 — Early-goal draw fade in soccer**
  - If a match opens 0-0 and one team scores in first 15', TIE drops sharply; sometimes mispriced
  - Potential entry window

---

## 6. Data hygiene checklist

Things we need tracked but aren't yet:

- [ ] `timeOfDay`, `dayOfWeek`, `gameClockAtEntry` (already partial via periodAtEntry)
- [ ] `bullpenState` snapshot at entry (MLB)
- [ ] `closerAvailable` bool (MLB)
- [ ] `goalieStarted` confirmation (NHL)
- [ ] `weatherConditions` (MLB outdoor, soccer)
- [ ] `marketDepth` / `liquidity` at entry price
- [ ] `sharpMoneyMove` (pre-game line movement in hours before kickoff)
- [ ] `postSettlement_stopReview` already exists; extend to include *forward* calibration impact

---

## 7. Decision log (update as we ship)

| Date | Decision | Rationale | Outcome |
|---|---|---|---|
| 2026-04-22 | Freeze MLB pre-game edge-first | 1-5 WR on 4/22 session | Holds |
| 2026-04-23 | Ship full stop-overhaul (11 commits) | DAL@MIN loss exposed stop overlaps | TBD (need forward data) |
| 2026-04-23 | Cut TIE leg into soccer pre-game prompt | Claude not pricing draw risk | TBD |
| 2026-04-23 | Raise pg-hard-stop threshold 12¢→25¢ | Data: 4 BAD stops at 12-15¢ threshold, −$79 | TBD |
| 2026-04-23 | Ship Phase 1 (P1.1-P1.4) | Kill known bleeding patterns; data-backed | TBD |
| 2026-04-23 | Ship P2.3 + P3.3 | Bullpen state in late-MLB exits + time-of-day logging | TBD |

---

## 8. Open questions

1. Is live-swing worth fixing or should it die? Data says die; need 1-2 more weeks.
2. Should pre-game-edge-first be re-enabled for any non-MLB sport after validation?
3. When do we implement a size-cap-on-losing-streak mechanism?
4. Do we add sharp-money line-movement tracking as an entry filter?
5. Should draw-bet expand beyond EPL?

---

*Update this doc when:*
- *A new audit runs (append to Findings, update Scorecard)*
- *A phase item ships (check box, log in Decision Log)*
- *A regime change happens (outlier pattern reverses, new sport)*
- *A new Claude prompt is added (extend inventory)*
