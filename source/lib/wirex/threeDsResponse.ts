// The outcome of answering an in-app 3DS challenge. Only an Approve the server
// accepted reads as approved: a decline, or any failed call (expired, refused,
// network), never shows the approval confirmation (#1585).
export type ThreeDsResponseOutcome = "approved" | "declined" | "failed";

export async function submit3dsResponse(
  send: () => Promise<void>,
  approve: boolean,
): Promise<ThreeDsResponseOutcome> {
  try {
    await send();
  } catch {
    return "failed";
  }
  return approve ? "approved" : "declined";
}

// The generation of the 3DS view. Dismiss, reset (which runs before the lock
// screen) and a session change invalidate it, so a response that settles
// afterwards still reconciles the pending list but never reopens the view.
export function createViewEpoch() {
  let epoch = 0;
  return {
    capture: () => epoch,
    invalidate: () => {
      epoch += 1;
    },
    isCurrent: (captured: number) => captured === epoch,
  };
}
