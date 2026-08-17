## Scoring Rubric for Implication Edge Classification

### strict_implication (confidence ≥ 0.90)
- The logical guarantee is **absolute** with no exceptions
- Based on rules of the game/system, not probability
- Examples:
  - "Win NBA Finals" ⟹ "Reach NBA Finals" (you can't win without reaching)
  - "BTC $200k by March" ⟹ "BTC $200k by December" (March is before December)
  - "Score 50 goals" ⟹ "Score 30 goals" (50 > 30)

### equivalence (confidence ≥ 0.88)
- Same question, same resolution criteria
- May be on different platforms
- Minor wording differences are OK if resolution is identical
- Watch out for: different resolution sources, different date cutoffs, different metrics

### conditional (confidence ≥ 0.70)
- Very likely but not guaranteed
- >90% probability of co-resolution
- Edge cases exist but are rare
- Example: "Win group stage" → "Qualify for tournament" (usually but wild-card formats may differ)

### probabilistic (confidence ≥ 0.50)
- Correlated but no logical link
- Example: "Team A wins" and "Their rival Team B loses"
- NOT useful for risk-free arbitrage, but useful for portfolio hedging

### no_implication (confidence < 0.50)
- No meaningful logical connection
- Reject the edge
