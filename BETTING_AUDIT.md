
# Arbor Betting Strategy Audit
**Date:** April 13, 2026 | **Bankroll:** ~$250 | **Settled Trades:** 15

---

## Executive Summary

The live-edge engine is demonstrably profitable when it fires correctly. The settled trade data shows **14 wins, 1 loss** — a 93% win rate on 15 settled trades, +$151 total P&L. But this data is misleading because: (a) most came from Saturday night's NBA session before the ctx bug was fully characterized, (b) tonight's CAR@PHI and other trades are still `closed-manual` with no P&L recorded, and (c) the pre-game spam distorted capital deployment severely. The real question isn't "does the engine work" — it clearly does when it finds genuine edge — but "is the prompt selecting the right spots?"

---

## What Worked (Backed by Data)

### NBA Late-Game Blowouts — Our Best Bet Type

**Evidence from settled trades:**
- PHX@OKC: 3 entries, all won, +$22.56 total. OKC resting SGA/Holmgren/Williams, PHX cruised. Entries at 71c, 75c, 84c, 85c.
- DEN@SAS: 4 entries, all won, **+$66.14 total**. Jokic dominating against tanking Spurs. Entries at 69c, 69c, 51c, 69c.
- LAC vs GSW: 1 entry, won, +$7.26. 10-pt home lead in Q2.

**Why this works:**
NBA blowouts are the most reliable live betting situation in all sports. The 3-point era has made large leads more secure (15-pt Q4 comeback = 8%, 20-pt = <2%), but the key factor in our profitable trades was **opponent context**: Spurs were actively tanking, OKC was resting all starters. The market priced these as competitive games; Claude correctly identified "this is a walkover."

**The DEN@SAS 51c entry** at Q3 with a 10-pt lead is the best trade of the session — bought when the market was still conservative, rode it to settlement. This is exactly what the system should be doing: finding moments where the market is behind the actual game state.

**What the prompt gets right for NBA:**
- "MODERN NBA: 15-pt comebacks happen 13% now (3pt era)" — correct context
- "Star player dominating (25+ pts) → UP 3-5%" — Jokic's 23+ pts was correctly factored
- "Star player in foul trouble → DOWN 5-10%" — important safety check

**What's still missing for NBA:**
- **Tanking team context.** When a team is deliberately losing for draft positioning (SA Spurs, several others), they don't just have bad players — they have players who aren't trying to win. This should be a HARD NO for betting the other team at premium prices, AND a massive DOWN adjustment for the tanking team. The market doesn't fully price this. Our bot found it via web search, but the prompt doesn't explicitly call it out.
- **Playoff seeding stakes.** In April, teams with locked seeds rest differently than teams fighting for position. PHX was motivated; SA wasn't. This dimension is underweighted.
- **Back-to-back fatigue.** Second game of a back-to-back reduces a team's win probability by 2-4%. Should be explicitly checked.

---

### NHL 2-Goal Leads in P2/P3 — Solid but Treacherous

**Evidence from settled trades:**
- PIT@WSH: 1 entry at 80c, +$6. Won. NHL P3 2-goal lead held.
- UTA@CGY: After two stop-losses on UTA (bad bets), bot correctly identified CGY at 77c with 2-goal P2 lead and won +$10.35.

**What worked:**
The baseline tables (80% for 2-goal P2, 93% for 2-goal P3) are accurate. When we bet the RIGHT team with a 2-goal lead, we won.

**What failed:**
- **OTT@NJ:** Three entries on OTT (Ottawa leading in P2/P3), all lost or stopped. -$23.57 total. NJ came back despite Ottawa leading. Ottawa's win probability was real but NJ is the better team — this was "inferior team protecting a lead" problem before we had that rule.
- **CAR@PHI:** 2-0 lead in P2, $52 deployed. PHI tied it (with CAR resting 5 starters). -$4 after manual cash-out. The resting starters rule would have blocked this.
- **SJ@NSH:** 1-0 lead in P3, $19.60 deployed. Bad goalie (.885 SV%), bottom team, 15-game H2H streak. Marginal trade that should have been a NO.

**Research findings on NHL goalie save percentage:**
Per NHL.com research and Carnegie Mellon analytics: "A .01 difference in save percentage translates to about 10-20 goals per year." A goalie at .885 is giving up roughly 1 goal per 9 shots. Over a full period (20 min), against a good team getting 10-15 shots, expected additional goals = 1-1.5. This is enormous in a 1-goal lead situation. The new .905 threshold we added is correct — but the DOWN adjustment should arguably be stronger for truly bad goalies (.885 and below = DOWN 8-10%, not just 5-8%).

---

### MLB — Profitable When Leads Are Decisive, Dangerous When Early

**Evidence from settled trades:**
- ATH@NYM (two entries): +$7.22, +$17.64. MLB 1-run lead in the 5th. Won.
- HOU@SEA: +$15.20. MLB mid-game, led to settlement.

**What worked:**
Claude's web search correctly identified pitching matchups and led to winning bets on medium-game MLB situations. The 2-run/5th inning+ window was the right entry point — not too early, not so late the market had already moved to 90c+.

**What failed:**
- **ARI@BAL:** We bet ARI at 75c (4-1 lead, 5th inning, 86% WE). BAL scored 5 runs in 2 innings. Lost. This is the inherent MLB problem: explosive innings (HR with runners on = instant erasure).
- **Pre-game MLB spam:** Multiple entries on CLE@STL, MIA@ATL, etc. at 49-53c. Way too early, wrong amount, bad duplicate detection.

**Research findings on MLB variance:**
Per vsin.com 2026 MLB analysis: "oddsmakers still base their lines on starting pitchers, with relief pitchers almost ignored." This is actually our edge — the market underweights bullpen transitions. When a team's starter exits in the 5th and the market hasn't repriced for bullpen quality, that's where Claude's web search finds real value.

But the BAL@ARI situation shows the other side: even a 4-1 lead in the 5th can evaporate in 3 pitches (3-run HR). The variance is irreducible.

**Key insight from the data:** Our MLB wins came at entry prices of 58-62c (lower risk/reward), not 75c+ (where we're now capped anyway). The sweet spot for MLB live betting is 55-70c with the leading team having a dominant pitcher still in the game. That's a sub-75% WE situation... which means our new 75% WE floor might be too aggressive for MLB. This needs more data.

---

## Sport-by-Sport Prompt Assessment

### NHL — Rating: B+ (Good, Needs Tuning)

**Prompt strengths:**
- Goalie SV% factors (UP and DOWN) — correct
- Resting starters rule — critical addition
- Playoff motivation mismatch — learned from PHI/CAR
- H2H dominance — just added, needed
- Compounding negatives — just added

**Prompt weaknesses:**

1. **Power play percentage not explicitly called out.** NHL PK (penalty kill) is a massive factor. A team with 75% PK (league worst) protecting a 1-goal lead in P3 is dramatically different from a team with 85% PK. One penalty call changes everything. The prompt doesn't mention PP/PK stats even though we have ESPN data on special teams.

2. **Empty net framing is incomplete.** "Empty net situation → DOWN 5-10%" — this is backwards. If the LEADING team is about to pull the goalie (trailing is your team), that's bad for the trailing team. If YOUR team is leading and the other team has pulled their goalie, that's an empty net opportunity that actually INCREASES win probability significantly (scoring into an empty net = +99% effectively). The current phrasing is confusing.

3. **Overtime/Shootout context missing.** As the game approaches tied with <5 minutes left in P3, the probability of OT increases rapidly. In OT, the better team's advantage is reduced (one-goal game, coin-flip atmosphere). If OT probability is >30%, the leading team's contract has much less value than the baseline suggests. This needs explicit handling.

4. **Goalie quality threshold is wrong.** Research shows that in 2026, the league-average SV% has declined to around .900 due to changing shot patterns. So .905 as the "bad goalie" threshold is actually slightly above average now. Should be recalibrated: excellent = .920+, average = .905-.919, below average = .895-.904, bad = below .895.

**Pro bettor recommendation:** Add a "special teams check" instruction. When Claude searches for injury/H2H data, explicitly tell it to look up PK% and PP%. A team with elite penalty kill (85%+) protecting a 1-goal lead is 3-5% safer than the baseline. A team with terrible PK (74%--this is real league data) is 4-6% more vulnerable.

---

### NBA — Rating: A- (Our Best Sport, Minor Gaps)

**Prompt strengths:**
- 3-point era comeback acknowledgment — correct
- Star player foul trouble — important
- Time remaining emphasis — critical

**Prompt weaknesses:**

1. **No specific Q4 vs Q3 distinction in instructions.** The difference between "down 15 in Q3" and "down 15 in Q4" is enormous. Q3 with 12 min left = 85% baseline. Q4 with 6 min left = 96%+ baseline. The prompt says "time remaining matters more than period" but doesn't give Claude specific thresholds. A 15-point lead with 8 minutes in Q4 should be treated very differently from the same lead with 8 minutes in Q3.

2. **Momentum/run context missing.** If Team A just went on a 12-0 run in Q3 and Team B called timeout, that's a very different situation than Team A building a lead gradually. Research shows that momentum runs in NBA break WE models temporarily — the market often doesn't reprice fast enough after a run. This is an edge we're leaving on the table.

3. **Home court advantage in playoffs.** Our WE tables are from regular season data. In NBA playoffs (starting in a couple weeks), home court advantage is more pronounced — teams are 62-65% at home vs 58-60% in regular season. If we're still betting NBA games after playoffs start, we need to tell Claude this.

4. **Garbage time detection is missing.** When a game is effectively over (e.g., 25-pt lead with 4 min left), the quality of play changes — stars sit, second units play, scoring rates increase. The market prices these games correctly at 95-99c. But the intermediate zone (15-20 pt lead with 6-8 min left) is where both "garbage time beginning" and "genuine gameplay" coexist. Claude needs to assess: are the stars still in?

**Pro bettor recommendation:** Add explicit "stars still playing?" check. When a team has a 20+ point lead in Q4, top NBA teams pull their starters. If the starters are still in (both teams close, competitive game), it's safer. If they've been pulled, the "lead" is somewhat artificial. This is easily searchable via web search.

---

### MLB — Rating: C+ (Profitable But Volatile, Needs Major Tuning)

**Prompt strengths:**
- Pitcher ERA factored in (UP for < 3.0, DOWN for weak bullpen)
- Team batting average provided
- Line scores provided
- Runners on base/outs in situation context

**Prompt weaknesses:**

1. **Bullpen depth not addressed.** The most valuable MLB insight from research (vsin.com, oddsshark) is that "oddsmakers ignore bullpen." When a starter exits in the 5th with a 4-run lead, the game enters a different phase — it's now a bullpen game. The prompt has no concept of "which bullpen is coming in?" or "how many relief pitchers has this team used in the last 3 days?" A bullpen that's thrown 6+ innings in the last 3 days is vulnerable in a way the market may not price.

2. **Home run volatility not explicit.** Baseball's fundamental asymmetry: a single 3-run HR erases a 3-run lead in one pitch. The prompt has no instruction to DOWN-adjust confidence when the trailing team has multiple power hitters coming up with runners on base. This was the BAL situation exactly — Henderson and Ward at the plate with runners on. Claude should be told: "If the trailing team has two or more HR threats coming up (25+ HRs/yr) with runners on base, reduce confidence by 5-8% regardless of run differential."

3. **Starting pitcher exit timing not flagged.** If the starter is at 85+ pitches in the 5th inning, they're likely coming out within 2 innings. This is a critical transition point. Claude should check: "Is the starting pitcher likely to finish the game or will this become a bullpen situation?" Starters with high pitch counts = more uncertainty.

4. **Specific ballpark effects absent.** Coors Field (Colorado) increases scoring 25-30% compared to average. Petco Park (San Diego) suppresses it. A 3-run lead at Coors is worth less than a 3-run lead at Petco. This is a specific, quantifiable factor.

5. **The 75% WE floor might be too aggressive for mid-game MLB.** A 2-run lead in the 4th inning is 76% WE — barely passes. But a 2-run lead with an ace pitcher going and a depleted opposing lineup might be 82-85% after adjustments. The floor prevents Claude from even seeing this situation. Consider dropping MLB WE floor to 70% and letting Claude's analysis decide.

**Pro bettor recommendation:** Add a mandatory "bullpen check" for MLB. When the starting pitcher has thrown 80+ pitches OR is past inning 5, explicitly tell Claude to search for: (1) how many IP the bullpen has thrown in the last 3 days, (2) what ERA the incoming relievers have, (3) whether the team's closer is available. This is where the real MLB edge lives.

---

### Soccer — Rating: B (Niche but Mathematical)

**Prompt strengths:**
- Draw rate warning for teams with high draw history — excellent
- Red card impact quantified — correct
- Draw probability math for 0-0 games — solid

**Prompt weaknesses:**

1. **Specific minute windows underemphasized.** Research (brendansudol.github.io) shows draw probability in 0-0 games peaks between minutes 75-85. The prompt mentions draws generally but doesn't give Claude specific time thresholds to target.

2. **Away teams vs home teams in draws.** Away teams draw slightly more than home teams (teams playing for a point on the road). A neutral 0-0 draw probability of 78% at the 72nd minute should be adjusted UP if it's a road team (they'll be happy to hold).

3. **Match importance context.** End-of-season meaningless games have higher draw rates than games with something at stake for one or both teams.

---

## The Core Prompt Problem: Claude Is Too Willing to Rationalize

The single biggest issue, seen across all sports, is **motivated reasoning**. Claude is instructed to analyze and then bet if confidence ≥ 65% and 3 points above price. But the research from professional bettors is clear: the most common mistake is finding reasons to bet rather than looking for reasons NOT to bet.

Professional bettors describe their process as **elimination first, then confirmation**. You start by looking for reasons to pass:
- Is the leading team the better team?
- Is the goalie reliable?
- Is there any contextual factor that makes this game unusual?
- Is the H2H history favorable?

If you've found no compelling reason to pass, THEN you look at whether the edge is real.

Our prompt does the opposite — it instructs Claude to "start from the baseline, adjust up or down, and BUY if the threshold passes." This primes Claude to look for a YES.

The SJ@NSH bet is the proof: Claude found all the negative factors (bad goalie, inferior team, 15-game H2H streak against them) but still bet because the marginal math barely cleared the bar. A professional bettor would have stopped at "bad goalie on a bottom-5 team against a team that's beaten them 15 times in a row" and said: "This is a pass."

---

## Specific Recommended Prompt Changes (Priority Order)

### Priority 1 — NBA: Add tanking and back-to-back checks
```
- TANKING TEAM: If the TRAILING team is known to be tanking for draft picks 
  (bottom standings, eliminated, trading veterans), their win probability 
  is 5-10% LOWER than their record suggests — they're not trying to win. 
  This is a BUY signal for the leading team, not a reason to hesitate.
- BACK-TO-BACK FATIGUE: If either team is playing second game of a 
  back-to-back, reduce their win probability by 2-4%. Check this via 
  web search.
```

### Priority 2 — NHL: Add special teams and OT probability
```
- SPECIAL TEAMS: Search for current PP% and PK% for both teams. 
  PK below 78%: leading team DOWN 3-5% (one penalty = likely equalizer).
  PK above 84%: leading team UP 2-3%.
- OT RISK: If the score is 1-0 with <8 minutes in P3, the probability 
  of OT is ~25-35%. In OT, the better team's advantage drops significantly 
  (coin-flip one-goal game). Factor this into your confidence — a 70% 
  win probability at 5-0 with 8min left is NOT the same as 70% at 1-0 
  with 8min left.
```

### Priority 3 — MLB: Add bullpen and HR vulnerability
```
- BULLPEN TRANSITION CHECK (MANDATORY): If the starting pitcher has 
  thrown 80+ pitches or it's past inning 5, search for: (1) bullpen 
  ERA in last 7 days, (2) how many innings they've thrown in 3 days,
  (3) whether the closer is available. A tired bullpen protecting a 
  3-run lead is dramatically less safe than a fresh one.
- HOME RUN VULNERABILITY: If the trailing team has 2+ power hitters 
  (25+ HR/yr) coming up with runners on base, reduce confidence by 
  5-8% regardless of run differential. Baseball can erase any lead 
  in one swing.
```

### Priority 4 — Universal: Restructure from elimination to confirmation
Change the prompt framing from:
> "Start from baseline, adjust, BUY if passes threshold"

To:
> "Before analyzing edge, first CHECK for disqualifying factors. 
> If ANY of these exist, say NO immediately without further analysis:
> [list disqualifiers]
> Only if none of the above apply, proceed to edge analysis."

This mirrors how professional bettors think — elimination first.

### Priority 5 — Universal: Require stated edge minimum to match conviction
Add after the decision instruction:
> "Before submitting your JSON, ask yourself: If this exact situation 
> occurred 100 times, would you bet it every time with conviction? 
> Or are you betting because you found enough math to justify it?
> The former is a good bet. The latter is a pass."

---

## What to Stop Doing Entirely

1. **Pre-game MLB bets.** Until we have 50+ validated live-edge trades and a provable win rate, no pre-game MLB. The market is too efficient, the variance is too high, and we have no proven edge in that format.

2. **Betting within 10 minutes of game start (live-edge).** The first 10 minutes of any game are the noisiest period — quick goals, scoring bursts, and bad starts all create market volatility with no statistical signal. Our WE baseline requires at least one full "state" change (scoring play) before we have a baseline to work from anyway.

3. **Any bet where the leading team is bottom-30% of the league.** Not as a guideline — as a hard code filter. The SJ@NSH bet could have been blocked in code before Claude even saw it. Add: if the leading team's win percentage is below 0.40, automatically skip this candidate.

---

## Summary: What's Good, What's Not

| Element | Assessment |
|---------|-----------|
| NBA blowout betting | ✅ Best performing, keep |
| NHL 2-goal P2/P3 | ✅ Good when team quality matched |
| NHL 1-goal P3 with bad goalie | ❌ Stop unless goalie is quality |
| MLB mid-game bullpen situations | 🟡 Marginal, need more data |
| MLB early game (inning 1-4) | ❌ Filter already added (75% WE) |
| Soccer draw betting math | ✅ Keep, most mathematical |
| Pre-game NHL (BUF, VGK picks) | 🟡 Good analysis, bad execution (spam bug) |
| Pre-game MLB | ❌ Disabled, leave off |
| H2H awareness | ❌ Was absent, now added |
| Goalie quality weighting | 🟡 Added, but thresholds need calibration |
| Resting starters | ❌ Was absent, now added |
| Playoff motivation | ❌ Was absent, now added |
| JSON-reasoning consistency | ❌ Known issue, now addressed |
| Bankroll per game cap | ❌ Was broken (key mismatch), now fixed |
| Elimination-first thinking | ❌ Not in prompt yet — top priority |
