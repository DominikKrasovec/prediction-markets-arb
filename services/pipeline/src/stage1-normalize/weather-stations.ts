/** Weather station name normalization, shared by every weather normalizer, so two
 *  cross-platform markets' `canonical_subject` can merge byte-equal at canonical_key time. */

/** Normalizes a station phrase; `city` strips a trailing ", <City>" so a later append doesn't double it. */
export function normalizeStationName(raw: string, city?: string): string {
  let s = raw
    .trim()
    .replace(/\s+Station\s*$/i, '')
    .replace(/,\s*[A-Z]{2}\s*$/u, '')
    .replace(/\bIntl\b/g, 'International')
    .replace(/\bIntern\.\b/gi, 'International')
    .replace(/-/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // deliberately NOT stripping " International Airport"/" Airport" (would collapse to an ambiguous bare city)
  if (city) {
    const cityWords = city.split(/\s+/);
    for (let n = cityWords.length; n >= 1; n--) {
      const prefix = cityWords.slice(0, n).join(' ');
      const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`,\\s*${escaped}\\s*$`, 'i');
      if (re.test(s)) {
        s = s.replace(re, '').trim();
        break;
      }
    }
  }
  return s;
}

/** Generates equivalent forms of a station subject as KB aliases (e.g. Kalshi's short
 *  form vs Polymarket's verbose form) without either side losing precision. */
export function stationAliasesFor(canonicalSubject: string, city: string): string[] {
  const aliases = new Set<string>([canonicalSubject]);
  const cityRe = new RegExp(`,\\s*${city.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'i');
  const stationBare = canonicalSubject.replace(cityRe, '').trim();
  if (!stationBare || stationBare.toLowerCase() === city.toLowerCase()) return [...aliases];

  const stationVariants = new Set<string>([stationBare]);

  const strippedAll = stationBare.replace(/\s+(?:International\s+)?Airport\s*$/i, '').trim();
  if (strippedAll && strippedAll.toLowerCase() !== city.toLowerCase() && strippedAll !== stationBare) {
    stationVariants.add(strippedAll);
  }

  const intlMatch = stationBare.match(/^(.+?)\s+International\s+Airport\s*$/i);
  if (intlMatch) stationVariants.add(`${intlMatch[1]} Airport`);
  const plainAirportMatch = stationBare.match(/^(.+?)\s+Airport\s*$/i);
  if (plainAirportMatch && !/International\s+Airport$/i.test(stationBare)) {
    stationVariants.add(`${plainAirportMatch[1]} International Airport`);
  }

  if (!/\b(Airport|Field|Base|Park|Station|Observatory)\b/i.test(stationBare)) {
    stationVariants.add(`${stationBare} Airport`);
    stationVariants.add(`${stationBare} International Airport`);
  }

  for (const v of stationVariants) {
    aliases.add(v);
    aliases.add(`${v}, ${city}`);
  }
  return [...aliases];
}

/** Polymarket names the station in "recorded at <Station> Station"; returns
 *  `"<NormalizedStation>, <City>"` or null when no station phrase is present. */
export function extractPolymarketWeatherStation(
  description: string | null,
  city: string,
): string | null {
  if (!description) return null;
  const m = description.match(/recorded at\s+(?:the\s+)?(.+?)\s+Station\b/i);
  if (!m) return null;
  const normalized = normalizeStationName(m[1], city);
  if (!normalized || normalized.toLowerCase() === city.toLowerCase()) return null;
  return `${normalized}, ${city}`;
}

/** Kalshi names the station in "recorded at|in <Station>[, <ST>] for <Date>..."; null for generic-city series. */
export function extractKalshiWeatherStation(
  rulesPrimary: string | null,
  city: string,
): string | null {
  if (!rulesPrimary) return null;
  const m = rulesPrimary.match(/recorded (?:at|in)\s+(.+?)\s+for\s+/i);
  if (!m) return null;
  const normalized = normalizeStationName(m[1], city);
  if (!normalized || normalized.toLowerCase() === city.toLowerCase()) return null;
  return `${normalized}, ${city}`;
}

/** Platform-agnostic station-phrase extraction for the Stage-3 weather veto (guards.ts):
 *  unlike the extractors above, does NOT append the city or null-out a city-equal phrase. */
export function extractStationPhrase(text: string | null): string | null {
  if (!text) return null;
  const pm = text.match(/recorded at\s+(?:the\s+)?(.+?)\s+Station\b/i);
  if (pm) {
    const s = normalizeStationName(pm[1]);
    return s || null;
  }
  const k = text.match(/recorded (?:at|in)\s+(.+?)\s+for\s+/i);
  if (k) {
    const s = normalizeStationName(k[1]);
    return s || null;
  }
  return null;
}

/** Resolution-oracle tag; same-station cross-platform merges carry inter-oracle basis risk. */
export function extractWeatherOracle(text: string | null): string | null {
  if (!text) return null;
  if (/wunderground/i.test(text)) return 'wunderground';
  if (/national weather service|climatological report|\bnws\b/i.test(text)) return 'nws';
  if (/accuweather/i.test(text)) return 'accuweather';
  return null;
}

/** Strips the trailing date phrase so both platforms produce an identical canonical_event
 *  for the same metric+city (date is redundant with `condition_date` in the key). */
export function stripWeatherDateSuffix(canonicalEvent: string): string {
  if (!canonicalEvent) return canonicalEvent;
  return canonicalEvent
    .replace(
      /\s+(?:on|in)\s+(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}(?:,?\s*\d{4})?\??\s*$/i,
      '',
    )
    .replace(/\?\s*$/, '')
    .trim();
}
