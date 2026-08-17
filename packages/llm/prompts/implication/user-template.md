Decide the relationship between the two prediction markets shown below. Return the single JSON object specified in the system prompt.

**Reason the rule engine punted:** {{queueReason}}

## Market A (question_id={{a.question_id}})
- Title: {{a.title}}
- Subject: {{a.canonical_subject}}
- Shape: {{a.condition_shape}} / Direction: {{a.condition_direction}} / Metric: {{a.condition_metric}}
- Temporal: {{a.temporal_semantics}}
- Values: primary={{a.value_primary}}, secondary={{a.value_secondary}}, unit={{a.value_unit}}
- Condition date: {{a.condition_date}}
- Hierarchy: {{a.hierarchy_type}} / level {{a.hierarchy_level}} / series {{a.hierarchy_series}}
- Resolution source: {{a.resolution_source}}

## Market B (question_id={{b.question_id}})
- Title: {{b.title}}
- Subject: {{b.canonical_subject}}
- Shape: {{b.condition_shape}} / Direction: {{b.condition_direction}} / Metric: {{b.condition_metric}}
- Temporal: {{b.temporal_semantics}}
- Values: primary={{b.value_primary}}, secondary={{b.value_secondary}}, unit={{b.value_unit}}
- Condition date: {{b.condition_date}}
- Hierarchy: {{b.hierarchy_type}} / level {{b.hierarchy_level}} / series {{b.hierarchy_series}}
- Resolution source: {{b.resolution_source}}
