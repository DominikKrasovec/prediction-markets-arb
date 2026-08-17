Two prediction-market events from different platforms. Decide whether they are the same real-world event; if so, extract the unified outcome set and map each child market to an outcome.

When a child line carries a `[resolves: …]` tag, that is the platform's OWN declaration of which outcome that specific market settles — use it (NOT the child's ordinal position) to map the leg, especially when sibling titles are identical.

## Side A
- platform: {{side_a.platform}}
- platform_event_id: {{side_a.platform_event_id}}
- title: {{side_a.title}}
- grouping_type: {{side_a.grouping_type}}
- canonical_subject: {{side_a.canonical_subject}}
- participants: {{side_a.participants_str}}
- game_date (authoritative fixture/resolution date): {{side_a.condition_date}}
- deadline (administrative padding — DO NOT treat as the game date): {{side_a.deadline}}
- children ({{side_a.total_children}} total{{#side_a.is_sampled}}; showing the {{side_a.shown_children}} highest-volume{{/side_a.is_sampled}}):
{{#side_a.children}}
  - market_id {{market_id}} [scope: {{resolution_scope}}]{{#native_label}} [resolves: {{.}}]{{/native_label}}: {{title}}
{{/side_a.children}}

## Side B
- platform: {{side_b.platform}}
- platform_event_id: {{side_b.platform_event_id}}
- title: {{side_b.title}}
- grouping_type: {{side_b.grouping_type}}
- canonical_subject: {{side_b.canonical_subject}}
- participants: {{side_b.participants_str}}
- game_date (authoritative fixture/resolution date): {{side_b.condition_date}}
- deadline (administrative padding — DO NOT treat as the game date): {{side_b.deadline}}
- children ({{side_b.total_children}} total{{#side_b.is_sampled}}; showing the {{side_b.shown_children}} highest-volume{{/side_b.is_sampled}}):
{{#side_b.children}}
  - market_id {{market_id}} [scope: {{resolution_scope}}]{{#native_label}} [resolves: {{.}}]{{/native_label}}: {{title}}
{{/side_b.children}}

## Context
- ann_cosine_distance: {{ann_cosine_distance}}

Map each outcome_id to a leg for EVERY platform that has a market for that outcome (same outcome across A and B → one outcome_id, two legs). Use only the market_id values listed above. Return strict JSON matching event-match/schema.json.
