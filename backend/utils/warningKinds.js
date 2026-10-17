/**
 * Warning kinds (October 2026).
 *
 * A generation produces dozens of warnings. Most are information (how much
 * data was fetched or loaded from the cache, how many ways were split); a
 * few say the user must check or fix something in the files. The website
 * used to show only the first five, which hid every "PLATFORMS MERGED"
 * warning at La Spezia. Now every warning is put in one of three groups:
 *
 *  - serious:  data is missing or something failed (an OpenStreetMap fetch,
 *              elevation data, an alternative route). Always shown in full.
 *  - review:   the user should check or fix something in the files
 *              (platform merges and numbers, slips, diamonds, link problems,
 *              no speed data, ...). Always shown in full.
 *  - info:     what the generator did. Shown on request ("show all") and
 *              shortened for the agent.
 *
 * A warning that matches no rule counts as "review", so a new kind of
 * warning is never hidden by mistake.
 */

const SERIOUS = [
  /fetch failed/i,
  /\bquery fail/i,
  /overpass[^.]*\b(fail|error)/i,
  /\bosm api\b/i,
  /\btimed? ?out\b/i,
  /rate.limit/i,
  /elevation (data )?unavailable/i,
  /^Alternative \d+ failed/i,
  /Topology JSON failed/i,
  /No valid geometry CSVs/i,
  /fewer than 2 valid points/i,
  /Broken link/i
];

const INFO = [
  /^Fetched \d+/i,
  /^Loaded \d+ cached/i,
  /^Topology: split \d+ ways/i,
  /^Topology JSON saved/i,
  /^Naming pass: renamed/i,
  /^Naming anchors available/i,
  /^Geometry pruning:/i,
  /^Post-alias pruning:/i,
  /^Removed \d+ (post-reciprocal )?orphaned/i,
  /^Filtered \d+ topology node/i,
  /^Draw: \d+ of \d+ nodes/i,
  /^Platforms: inserted \d+/i,
  /^Platform ".*" \([^)]*\): (island platform|tracks on both sides)/i,
  /^Boundary nodes: created/i,
  /^End nodes: /i,
  /^Reciprocal link enforcement:/i,
  /^2-branch normalisation:/i,
  /^F-branch fix:/i,
  /^Speedboards: \d+ speedboard row/i,
  /^Truncation produced fewer than 2 points/i,
  /^Elevation anchor:/i
];

/**
 * @param {string} warning
 * @returns {'serious'|'review'|'info'}
 */
export function warningKind(warning) {
  // A section prefix ("La Spezia - Sestri Levante: ...") does not change the kind.
  const text = String(warning);
  const bare = text.replace(/^[^:]{1,120}?: (?=[A-Z0-9])/, '');
  for (const t of [text, bare]) {
    if (SERIOUS.some(re => re.test(t))) return 'serious';
  }
  for (const t of [text, bare]) {
    if (INFO.some(re => re.test(t))) return 'info';
  }
  return 'review';
}

/**
 * Split warnings into the three groups, keeping their order.
 * @param {string[]} warnings
 * @returns {{serious: string[], review: string[], info: string[]}}
 */
export function groupWarnings(warnings) {
  const groups = { serious: [], review: [], info: [] };
  for (const w of Array.isArray(warnings) ? warnings : []) {
    if (typeof w !== 'string') continue;
    groups[warningKind(w)].push(w);
  }
  return groups;
}
