Two prediction-market events from different platforms. Write down each side's YES-region over Ω explicitly (quantity, condition, resolution window, resolution source), then compare the regions and return the relation.

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
  - market_id {{market_id}} [scope: {{resolution_scope}}]: {{title}}
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
  - market_id {{market_id}} [scope: {{resolution_scope}}]: {{title}}
{{/side_b.children}}

Step 1: state side A's YES-region. Step 2: state side B's YES-region. Step 3: compare (check oracle, temporal scope, exception rules) and return strict JSON matching event-reverify/schema.json.
