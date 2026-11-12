import { cookies } from "next/headers";
import {
  getMessages,
  resolveLocale,
  LOCALE_COOKIE,
  type Locale,
  type Messages,
} from "./i18n";

/** Resolve the active locale's message dictionary for a server page. */
export async function pageMessages(): Promise<Messages> {
  const store = await cookies();
  return getMessages(resolveLocale(store.get(LOCALE_COOKIE)?.value));
}

/** Resolve just the active locale code (e.g. for the language switcher). */
export async function pageLocale(): Promise<Locale> {
  const store = await cookies();
  return resolveLocale(store.get(LOCALE_COOKIE)?.value);
}
