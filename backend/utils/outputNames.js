/**
 * Download file names with a date stamp (October 2026).
 *
 * Same pattern as the Network Editor, which saves
 * <ProjectName>_<yyyy-MM-dd_HHmmss>.csv. Each geometry run has one stamp
 * (the time it started, session.json `outputStamp`) for the geometry ZIP,
 * Regions, Speedboards and the KMZ; each infrastructure run has its own new stamp
 * (`infrastructureStamp`), so regenerating Infrastructure never gives a
 * file the same name as before (decided 16 Oct 2026).
 *
 * Only the names people download are stamped:
 *   Infrastructure_<stamp>.csv, Regions_<stamp>.csv, Speedboards_<stamp>.csv,
 *   Geometry_<stamp>.kmz,
 *   the geometry ZIP and the agent's ZIP.
 * NOT stamped, on purpose:
 *   - the geometry CSV files and the "Geometry" folder in the ZIP. Traxim
 *     reads every *.csv in the scenario's geometry folder and takes each
 *     region's name from the first column, not from the file name, so their
 *     names do not matter to Traxim; but the Controller puts a scenario's
 *     geometry in a folder called Geometry, and keeping the names stable
 *     keeps one file per route easy to recognise between runs.
 *   - the files on the server (Infrastructure.csv, Regions.csv,
 *     Speedboards.csv): the code
 *     reads them by those names.
 * Stamped names still contain "Infrastructure" and "Regions", which is what
 * the Controller's older name-based upload route looks for.
 *
 * The stamp is in the server's chosen time zone: FILE_STAMP_TIME_ZONE (an
 * IANA name such as "Australia/Sydney" or "Europe/London"), default UTC.
 * Derek decided (16 Oct 2026) to keep UTC: names sort correctly whoever
 * makes them, it suits users anywhere, and Explorer shows each file's local
 * modified time anyway.
 */

const STAMP_PATTERN = /^\d{4}-\d{2}-\d{2}_\d{6}$/;

function timeZone() {
  const zone = process.env.FILE_STAMP_TIME_ZONE || 'UTC';
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: zone });
    return zone;
  } catch {
    console.warn(`[Output names] FILE_STAMP_TIME_ZONE "${zone}" is not a valid time zone; using UTC.`);
    return 'UTC';
  }
}

/**
 * "2026-10-16_093012" for the given moment.
 * @param {Date} [date]
 * @param {string} [zone] - IANA time zone (default: FILE_STAMP_TIME_ZONE or UTC)
 */
export function makeOutputStamp(date = new Date(), zone = timeZone()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
    }).formatToParts(date).map(p => [p.type, p.value])
  );
  return `${parts.year}-${parts.month}-${parts.day}_${parts.hour}${parts.minute}${parts.second}`;
}

export function isValidOutputStamp(stamp) {
  return typeof stamp === 'string' && STAMP_PATTERN.test(stamp);
}

/** "Infrastructure.csv" + stamp -> "Infrastructure_<stamp>.csv"; no stamp -> unchanged. */
export function stampedName(fileName, stamp) {
  if (!isValidOutputStamp(stamp)) return fileName;
  const dot = fileName.lastIndexOf('.');
  return dot > 0 ? `${fileName.slice(0, dot)}_${stamp}${fileName.slice(dot)}` : `${fileName}_${stamp}`;
}

/** A label made safe for a file name ("Genova - La Spezia" -> "Genova-La-Spezia"). */
export function safeFileBase(label, fallback = 'Traxim-files') {
  const base = String(label || '')
    .replace(/[^A-Za-z0-9 _.-]+/g, '').trim()
    .replace(/\s*-\s*/g, '-').replace(/\s+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '')
    .slice(0, 60);
  return base || fallback;
}
