Induce one regex template that parses the cluster of similar market titles shown below. Your regex must NOT match any of the negative examples. Return one JSON object per the schema.

CLUSTER (positive examples), {{count}} total:
{{#examples}}
- platform={{platform}} | shape={{condition_shape}} | event_kind={{event_kind}} | category={{category_unified}}
  title: "{{title}}"
  llm: subject="{{canonical_subject}}", value_primary={{value_primary_or_null}}, unit={{value_unit_or_null}}
{{/examples}}

NEGATIVE EXAMPLES (must NOT match):
{{#negatives}}
- "{{title}}"
{{/negatives}}
