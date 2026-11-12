import en from "../../public/messages/en.json";
import zhTW from "../../public/messages/zh-TW.json";
import ja from "../../public/messages/ja.json";
import ko from "../../public/messages/ko.json";
import es from "../../public/messages/es.json";
import pt from "../../public/messages/pt.json";
import fr from "../../public/messages/fr.json";

/**
 * Summa i18n — locale registry and message lookup.
 *
 * Supported locales (decided 2026-11-12): English is the source language;
 * Chinese ships as Traditional Chinese (zh-TW), matching the house
 * convention used across our sites. Dictionaries live in
 * `public/messages/{locale}.json`, English is the structural source of
 * truth — every other locale must carry the same keys (missing keys are a
 * release-blocking defect, see docs/milestone.md).
 *
 * The active locale is carried in the `summa-locale` cookie; the language
 * switcher writes it and the server renders from it.
 */
export const LOCALES = [
  { code: "en", label: "English" },
  { code: "zh-TW", label: "繁體中文" },
  { code: "ja", label: "日本語" },
  { code: "ko", label: "한국어" },
  { code: "es", label: "Español" },
  { code: "pt", label: "Português" },
  { code: "fr", label: "Français" },
] as const;

export type Locale = (typeof LOCALES)[number]["code"];

export const DEFAULT_LOCALE: Locale = "en";

export const LOCALE_COOKIE = "summa-locale";

export type Messages = typeof en;

const MESSAGES: Record<Locale, Messages> = {
  en,
  "zh-TW": zhTW as Messages,
  ja: ja as Messages,
  ko: ko as Messages,
  es: es as Messages,
  pt: pt as Messages,
  fr: fr as Messages,
};

export function isLocale(value: string | undefined | null): value is Locale {
  return !!value && LOCALES.some((l) => l.code === value);
}

/** Resolve an arbitrary cookie/header value to a supported locale. */
export function resolveLocale(value: string | undefined | null): Locale {
  return isLocale(value) ? value : DEFAULT_LOCALE;
}

export function getMessages(locale: Locale): Messages {
  return MESSAGES[locale] ?? MESSAGES[DEFAULT_LOCALE];
}
