Identify all pairs with a meaningful logical relationship in the cluster of prediction markets shown below. Return a JSON object with a `pairs` array. Include ONLY pairs with a relationship (equivalent, strict_implication_AtoB/BtoA, conditional, mutual_exclusion). Omit independent pairs. Any pair you omit will be re-reviewed individually — never silently mark a pair as independent by omission.

Cluster size: {{clusterSize}}

{{#markets}}
## Q{{question_id}} (id={{question_id}})
- Title: {{title}}
- Subject: {{canonical_subject}}
- Shape: {{condition_shape}} / Direction: {{condition_direction}} / Metric: {{condition_metric}}
- Temporal: {{temporal_semantics}}
- Values: primary={{value_primary}}, secondary={{value_secondary}}, unit={{value_unit}}
- Condition date: {{condition_date}}
- Resolution source: {{resolution_source}}

{{/markets}}
