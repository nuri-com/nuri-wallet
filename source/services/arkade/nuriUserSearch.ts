// Asks the Arkade server for Nuri usernames while a recipient is typed, so
// people not in the address book can still be picked (lib/send/nuriUserSearch).

import { useEffect, useState } from "react";
import { nuriSearchPrefix } from "../../lib/send/nuriUserSearch";
import { arkadeLnurlSearch } from "./ArkadeApiService";
import { getArkadeLnurlAssertion } from "./internal/identity";

/** One question per typing pause, not per key. */
const SEARCH_DEBOUNCE_MS = 250;

/**
 * Usernames for what is typed while `active`, with the prefix they answer.
 * Never a passkey prompt for a suggestion: without a cached login, none. A
 * failed or late answer leaves the list as it was; the caller filters it
 * against the current prefix.
 */
export function useNuriUserSearch(
  typed: string,
  active: boolean,
): { prefix: string | null; usernames: string[] } {
  const prefix = active ? nuriSearchPrefix(typed) : null;
  const [usernames, setUsernames] = useState<string[]>([]);

  useEffect(() => {
    if (!prefix) {
      setUsernames([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const assertion = await getArkadeLnurlAssertion("lnurl_search", false);
          if (!assertion || cancelled) return;
          const answer = await arkadeLnurlSearch(assertion, prefix);
          if (!cancelled) setUsernames(Array.isArray(answer.usernames) ? answer.usernames : []);
        } catch {
          // Offline or refused: no suggestions, the field still works.
        }
      })();
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [prefix]);

  return { prefix, usernames };
}
