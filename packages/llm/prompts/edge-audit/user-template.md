Audit the following {{count}} market pairs. For each pair, determine the relationship independently and return the JSON audit array.

{{#pairs}}
---
## Edge {{edge_id}} — (A = question {{a_question_id}}, B = question {{b_question_id}})

### Market A
- Title: {{a_title}}
- Subject: **{{a_subject}}**
- Shape: {{a_shape}} | Direction: {{a_direction}} | Metric: {{a_metric}}
- Temporal: {{a_temporal}}
- Values: primary={{a_value_primary}}{{#a_value_secondary}}, secondary={{a_value_secondary}}{{/a_value_secondary}}{{#a_value_unit}}, unit={{a_value_unit}}{{/a_value_unit}}
- Condition date: {{a_date}}
- Resolution source: {{a_resolution_source}}

### Market B
- Title: {{b_title}}
- Subject: **{{b_subject}}**
- Shape: {{b_shape}} | Direction: {{b_direction}} | Metric: {{b_metric}}
- Temporal: {{b_temporal}}
- Values: primary={{b_value_primary}}{{#b_value_secondary}}, secondary={{b_value_secondary}}{{/b_value_secondary}}{{#b_value_unit}}, unit={{b_value_unit}}{{/b_value_unit}}
- Condition date: {{b_date}}
- Resolution source: {{b_resolution_source}}

{{/pairs}}
---

Return one audit object per edge in the `audits` array (same order as above).
