// Sentinel persisted while a new passkey has been bootstrapped but its
// mandatory Lightning-username claim is still pending. Survives app kill so
// the cold-launch path can re-render UsernameOnboardingScreen instead of
// signing the user in past the gate. Must be wiped on factory reset / soft
// logout so a previous lifetime's sentinel doesn't gate a fresh sign-in.
export const USERNAME_CLAIM_REQUIRED_KEY = "username_claim_required";
