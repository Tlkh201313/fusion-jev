/** Shortens text to at most `max` characters; the marker counts toward `max` and replaces the cut tail. */
export const clip = (text: string, max: number, marker = '…'): string =>
  text.length > max ? `${text.slice(0, max - marker.length)}${marker}` : text;

/** Keeps the first `max` characters and appends `marker` after them (outside the budget) only when text was cut. */
export const excerpt = (text: string, max: number, marker = ''): string =>
  text.length > max ? `${text.slice(0, max)}${marker}` : text;
