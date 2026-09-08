/**
 * Regions.csv Generator
 *
 * Field semantics confirmed against the actual Traxim engine parser
 * (TraximCore/Process/InputRegions.cs), not just the (incomplete) skill
 * reference — that reference only documents Region Name, Colour, Train
 * Graph Order, and Opposing/Following Delay, but the real file (and the
 * parser) also has Reverse Section, Nominal Superelevation, and one
 * Nominal Cant Deficiency column per train speed class.
 *
 * Column layout: Region Name, Colour, Train Graph Order, Opposing Delay,
 * Following Delay, Reverse Section, Nominal Superelevation, then one
 * Nominal Cant Deficiency column per speed class (label taken from row 1
 * at that same column position — see below), then a mandatory blank
 * separator column before anything else.
 *
 * The mandatory first row (blank name, White, order 1) is structurally
 * required — the parser reads that row's own cant-deficiency column(s) as
 * the train SPEED CLASS LABELS (e.g. "Normal"), not as numeric values, and
 * uses those labels for every subsequent row's actual numeric values at
 * the same columns. This generator only ever defines a single "Normal"
 * class.
 *
 * Opposing/Following Delay, Nominal Superelevation, and Nominal Cant
 * Deficiency are all real operational/engineering judgements the generator
 * has no way to derive from OSM/geometry data — populated with the
 * engine's own defaults (90s / 90s / 120mm / 75mm) rather than left blank,
 * per Derek: an explicit default value is a clearer signal to review it
 * than an empty cell would be. Callers should surface DEFAULTS_WARNING to
 * the user.
 */

const DEFAULT_OPPOSING_DELAY = 90;
const DEFAULT_FOLLOWING_DELAY = 90;
const DEFAULT_SUPERELEVATION = 120;
const DEFAULT_CANT_DEFICIENCY = 75;

export const DEFAULTS_WARNING =
  `Regions.csv: Opposing/Following Delay (${DEFAULT_OPPOSING_DELAY}s), Nominal Superelevation ` +
  `(${DEFAULT_SUPERELEVATION}mm), and Nominal Cant Deficiency (${DEFAULT_CANT_DEFICIENCY}mm) were ` +
  `populated with default values for every region — these are real operational/track-engineering ` +
  `judgements the generator can't derive automatically. Review and adjust them for each region ` +
  `before using this file.`;

/**
 * @param {string[]} regionNames - Region names, one per geometry FILE actually produced
 *   (a segment's main centerline plus each of its alternative routes are each their own
 *   file and their own region - see backend/services/geometry/generator.js, whose first
 *   CSV column for each file is exactly the name that must appear here), in route order
 * @param {string[]} colourPalette - Region colour palette (e.g. REGION_COLOURS from infrastructure/generator.js)
 * @returns {string} CSV file content
 */
export function generateRegionsCsv(regionNames, colourPalette) {
  const lines = [
    '# First row of input data should always be blank for region name, "White" for colour and "1" for Train Graph Order. ',
    '# An unlimited number of train speed classes for nominal cant deficiency can be added from column H rightwards, but an empty column must be left between the last class and any column with non-input data.',
    '#Region Name, Colour, Train Graph Order,Opposing delay,Following Delay,Reverse Section,Nominal Superelevation,Nominal cant deficiency',
    // Mandatory first row: structural placeholder, not a real region — the
    // "Normal" here is the speed-class LABEL used by every row below, not a
    // data value for this row (see file header above).
    ',White,1,0,0,FALSE,,Normal,'
  ];

  regionNames.forEach((name, i) => {
    const colour = colourPalette[i % colourPalette.length];
    const order = i + 2; // 1 is reserved for the mandatory first row
    lines.push(
      `${name},${colour},${order},${DEFAULT_OPPOSING_DELAY},${DEFAULT_FOLLOWING_DELAY},` +
      `FALSE,${DEFAULT_SUPERELEVATION},${DEFAULT_CANT_DEFICIENCY},`
    );
  });

  return lines.join('\n') + '\n';
}
