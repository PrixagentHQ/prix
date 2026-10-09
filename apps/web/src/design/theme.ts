/**
 * The theme control of the header. A press switches the page between dark and light at once
 * and keeps the choice in the cookie `prix_theme` for a year, so the server renders the next
 * page in it from the first paint (Layout reads the cookie). The cookie holds the one word and
 * nothing else. Without this script the control stays hidden and the page keeps its theme.
 */

export type Theme = 'dark' | 'light';

export const THEME_COOKIE = 'prix_theme';
const YEAR = 60 * 60 * 24 * 365;

/** The cookie that keeps a theme: the word, a year, the whole site, sent on same-site visits only. */
export function themeCookie(theme: Theme, secure: boolean): string {
  return `${THEME_COOKIE}=${theme}; Max-Age=${YEAR}; Path=/; SameSite=Lax${secure ? '; Secure' : ''}`;
}

/** Puts the page in a theme: the attribute the styles read, the two meta tags, the control's name. */
export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  root.dataset.theme = theme;
  document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', theme);
  const colour = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  const value = colour?.dataset[theme];
  if (colour && value) colour.content = value;
  const control = document.querySelector<HTMLButtonElement>('[data-theme-toggle]');
  const name = theme === 'dark' ? control?.dataset.toLight : control?.dataset.toDark;
  if (control && name) control.setAttribute('aria-label', name);
}

function init(): void {
  const control = document.querySelector<HTMLButtonElement>('[data-theme-toggle]');
  if (!control) return;
  control.hidden = false;
  control.addEventListener('click', () => {
    const next: Theme = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    applyTheme(next);
    // biome-ignore lint/suspicious/noDocumentCookie: the Cookie Store API is missing from Firefox and older Safari; this cookie holds one word.
    document.cookie = themeCookie(next, window.location.protocol === 'https:');
  });
}

if (typeof document !== 'undefined') init();
