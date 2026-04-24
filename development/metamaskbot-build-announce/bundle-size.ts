import type { ArtifactLinks } from './artifacts';

/**
 * Converts a byte count to a human-readable string (e.g. "1.5 KiB").
 *
 * @param bytes - The size in bytes.
 * @returns Formatted string.
 */
export function getHumanReadableSize(bytes: number): string {
  if (!bytes) {
    return '0 Bytes';
  }

  const absBytes = Math.abs(bytes);
  const kibibyteSize = 1024;
  const magnitudes = ['Bytes', 'KiB', 'MiB'];
  let magnitudeIndex = 0;
  if (absBytes > Math.pow(kibibyteSize, 2)) {
    magnitudeIndex = 2;
  } else if (absBytes > kibibyteSize) {
    magnitudeIndex = 1;
  }
  return `${parseFloat(
    (bytes / Math.pow(kibibyteSize, magnitudeIndex)).toFixed(2),
  )} ${magnitudes[magnitudeIndex]}`;
}

/**
 * Calculates the percentage change between two values.
 *
 * @param from - The original value.
 * @param to - The new value.
 * @returns Percentage change rounded to 2 decimal places.
 */
export function getPercentageChange(from: number, to: number): number {
  if (from === 0) {
    return to === 0 ? 0 : 100;
  }
  return parseFloat((((to - from) / Math.abs(from)) * 100).toFixed(2));
}

/** The threshold for whether to highlight a change in bundle size, in bytes. */
const BUNDLE_SIZE_THRESHOLD = 1_000;

/**
 * Fetches bundle size stats and builds the bundle size diff collapsible section.
 *
 * @param artifacts - The artifact links object from getArtifactLinks.
 * @param mergeBaseCommitHash - The merge base commit hash for comparison.
 * @returns HTML string for the bundle size diff section, or empty string on error.
 */
export async function buildBundleSizeDiffSection(
  artifacts: ArtifactLinks,
  mergeBaseCommitHash: string,
): Promise<string> {
  const prBundleSizeStatsResponse = await fetch(artifacts.bundleSizeStats.url);
  if (!prBundleSizeStatsResponse.ok) {
    throw new Error(
      `Failed to fetch prBundleSizeStats, status ${prBundleSizeStatsResponse.statusText}`,
    );
  }
  // This annotation narrows the untyped json() result to the known schema of the bundle size stats artifact.
  const prBundleSizeStats: Record<string, number> =
    await prBundleSizeStatsResponse.json();

  const devBundleSizeStatsResponse = await fetch(artifacts.bundleSizeData.url);
  if (!devBundleSizeStatsResponse.ok) {
    throw new Error(
      `Failed to fetch devBundleSizeStats, status ${devBundleSizeStatsResponse.statusText}`,
    );
  }
  // This annotation narrows the untyped json() result to the known schema of the dev bundle size data.
  const devBundleSizeStats: Record<
    string,
    Record<string, number>
  > = await devBundleSizeStatsResponse.json();

  const bundleParts = [
    'background',
    'ui',
    'common',
    'other',
    'contentScripts',
    ...(prBundleSizeStats.zip === undefined ? [] : ['zip']),
  ] as const;

  const getDevSize = (part: string) =>
    devBundleSizeStats[mergeBaseCommitHash]?.[part];
  const getDiff = (part: string) => {
    const devSize = getDevSize(part);
    return devSize === undefined
      ? undefined
      : prBundleSizeStats[part] - devSize;
  };

  const sizeDiffRows = bundleParts.map((part) => {
    const devSize = getDevSize(part);

    if (devSize === undefined) {
      return `${part}: n/a`;
    }

    const diff = prBundleSizeStats[part] - devSize;

    return `${part}: ${getHumanReadableSize(diff)} (${getPercentageChange(
      devSize,
      prBundleSizeStats[part],
    )}%)`;
  });

  const sizeDiffHiddenContent = `<ul>${sizeDiffRows
    .map((row) => `<li>${row}</li>`)
    .join('\n')}</ul>`;

  const getCombinedDiff = (...parts: string[]) => {
    const diffs = parts.map(getDiff);

    return diffs.every((diff): diff is number => diff !== undefined)
      ? diffs.reduce((sum, diff) => sum + diff, 0)
      : undefined;
  };

  const sizeDiffBackground = getCombinedDiff('background', 'common');
  const sizeDiffUi = getCombinedDiff('ui', 'common');
  const warningDiffs = [sizeDiffBackground, sizeDiffUi].filter(
    (diff): diff is number => diff !== undefined,
  );

  let sizeDiffWarning: string | undefined;
  if (warningDiffs.some((diff) => diff > BUNDLE_SIZE_THRESHOLD)) {
    sizeDiffWarning = `🚨 Warning! Bundle size has increased!`;
  } else if (warningDiffs.some((diff) => diff < -BUNDLE_SIZE_THRESHOLD)) {
    sizeDiffWarning = `🚀 Bundle size reduced!`;
  }

  const sizeDiffTitle = `Bundle size diffs${sizeDiffWarning ? ` [${sizeDiffWarning}]` : ''}`;

  return `<details><summary>${sizeDiffTitle}</summary>${sizeDiffHiddenContent}</details>\n\n`;
}
