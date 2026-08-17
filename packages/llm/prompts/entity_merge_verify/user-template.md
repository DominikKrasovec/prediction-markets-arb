Decide whether each of the following {{count}} entity pairs represent the same real-world entity. Return one JSON object per pair in the SAME ORDER, wrapped in `{ "pairs": [ ... ] }`.

{{#pairs}}
---
PAIR {{index}}:

  side a:
    id: {{a_id}}
    canonical: "{{a_canonical}}"
    aliases: {{a_aliases_json}}
    type: "{{a_type}}"
    domain_category: "{{a_domain_category}}"
    metadata: {{a_metadata_json}}
    sample_titles:
{{#a_sample_titles}}
      - "{{.}}"
{{/a_sample_titles}}

  side b:
    id: {{b_id}}
    canonical: "{{b_canonical}}"
    aliases: {{b_aliases_json}}
    type: "{{b_type}}"
    domain_category: "{{b_domain_category}}"
    metadata: {{b_metadata_json}}
    sample_titles:
{{#b_sample_titles}}
      - "{{.}}"
{{/b_sample_titles}}

{{/pairs}}
