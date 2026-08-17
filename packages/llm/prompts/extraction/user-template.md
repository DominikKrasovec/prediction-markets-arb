Extract structured metadata from the following prediction market(s). Return a JSON array with one object per market, matching the provided schema exactly. Interpretation notes for the per-market fields below appear in the system prompt.

{{#markets}}
---
**Market {{index}}** (Platform: {{platform}})
- **Title**: {{title}}
- **Description/Rules**: {{description}}
- **Outcomes**: {{outcomes}}
{{#eventTitle}}- **Parent event**: {{eventTitle}}
{{/eventTitle}}{{#yesSubTitle}}- **YES resolves to**: {{yesSubTitle}}
{{/yesSubTitle}}{{#subtitle}}- **Outcome subtitle**: {{subtitle}}
{{/subtitle}}{{#slug}}- **Slug**: {{slug}}
{{/slug}}{{#occurrenceDatetime}}- **Event occurs at**: {{occurrenceDatetime}}
{{/occurrenceDatetime}}- **Category hint**: {{categoryHint}}
- **End Date**: {{endDate}}
---
{{/markets}}
