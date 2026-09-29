/** Thrown when the arkade server returns HTTP 400 for an already-claimed name. */
export class UsernameAlreadyClaimedError extends Error {
  constructor(username: string) {
    super(`username already claimed: ${username}`);
    this.name = "UsernameAlreadyClaimedError";
  }
}
