## KB taxonomy (use these exact strings when applicable)

known_sports:
{{#known_sports}}
  - "{{.}}"
{{/known_sports}}

known_leagues:
{{#known_leagues}}
  - "{{.}}"
{{/known_leagues}}

---

Enrich the following entities. Return one JSON object per entity in the SAME ORDER, wrapped in `{ "entities": [ ... ] }`.

{{#entities}}
---
ENTITY {{index}}:
- canonical_now: "{{canonical_now}}"
- aliases_now: {{aliases_json}}
- domain_category: "{{domain_category}}"
- type_hint: "{{type_hint}}"
- sport_hint: {{sport_hint_or_null}}
- sample_titles:
{{#sample_titles}}
  - "{{.}}"
{{/sample_titles}}
{{#sample_descriptions_section}}
- sample_descriptions:
{{#descriptions}}
  - "{{.}}"
{{/descriptions}}
{{/sample_descriptions_section}}
{{#platform_signals_section}}
- platform_signals:
{{#signals}}
  - {{label}}: {{value}}
{{/signals}}
{{/platform_signals_section}}
{{#co_entities_section}}
- co_entities (most-frequent enriched neighbours):
{{#co_entities}}
  - "{{canonical}}" ({{type}})
{{/co_entities}}
{{/co_entities_section}}
{{#parent_events_section}}
- parent_events (parent platform_events.title, one per platform the entity appears on):
{{#parent_events}}
  - {{platform}}: "{{title}}"
{{/parent_events}}
{{/parent_events_section}}

{{/entities}}
