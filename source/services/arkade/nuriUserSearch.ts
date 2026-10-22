// Asks the Arkade server for Nuri usernames while a recipient is typed, so
// people not in the address book can still be picked (lib/send/nuriUserSearch).

import { useEffect, useState } from "react";
import { nuriSearchPrefix } from "../../lib/send/nuriUserSearch";
import { authStateManager } from "../auth/AuthStateService";
import { arkadeLnurlSearch } from "./ArkadeApiService";

/** One question per typing pause, not per key. */
const SEARCH_DEBOUNCE_MS = 250;

/**
 * Usernames for what is typed while `active`, with the prefix they answer,
 * never the user's own. The search needs no login, so it never prompts and
 * works however long ago the passkey was used. A failed or late answer leaves
 * the list as it was; the caller filters it against the current prefix.
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
          const answer = await arkadeLnurlSearch(prefix);
          if (cancelled) return;
          const own = (authStateManager.getState().walletUsername ?? "").toLowerCase();
          const names = Array.isArray(answer.usernames) ? answer.usernames : [];
          setUsernames(names.filter((name) => name.toLowerCase() !== own));
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
