/**
 * The three ways a user writes a Nuri recipient — `lennard`, `lennard.nuri.eth`,
 * `lennard@nuri.com` — reduced to the one username they all name.
 *
 * Syntax only: a non-null answer says "this is shaped like a Nuri username",
 * never "this user exists". The caller resolves it (`resolvePayRecipient`)
 * before any money moves.
 */

import { ENS_PARENT_DOMAIN } from "../../config/constants";
import { USERNAME_REGEX } from "../arkade/usernameAvailability";
import { isEnsName } from "../qr/resolveEns";

const LIGHTNING_SUFFIX = "@nuri.com";
const ENS_SUFFIX = `.${ENS_PARENT_DOMAIN}`;

export function toNuriUsername(input: string): string | null {
  let value = String(input || "")
    .trim()
    .toLowerCase();
  if (!value) return null;

  if (value.endsWith(LIGHTNING_SUFFIX)) {
    value = value.slice(0, -LIGHTNING_SUFFIX.length);
  } else if (value.endsWith(ENS_SUFFIX)) {
    value = value.slice(0, -ENS_SUFFIX.length);
  } else if (isEnsName(value)) {
    // `vitalik.eth` is somebody's ENS name, not the Nuri user "vitalik.eth" —
    // the username alphabet allows dots, so this has to be ruled out by hand.
    return null;
  }
  // `@lennard` is how people write a handle.
  if (value.startsWith("@")) value = value.slice(1);

  return USERNAME_REGEX.test(value) ? value : null;
}
