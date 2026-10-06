// How an activity row names a saved contact. The direction decides the
// wording: money in was sent BY them, money out was received BY them. A row
// that does not state its direction is never renamed, so a payment can never
// read the wrong way round.
export type ContactRowLabelKey =
  | "component.ActivityRowActions.contactSent"
  | "component.ActivityRowActions.contactReceived";

export function contactRowLabelKey(incoming: boolean | undefined): ContactRowLabelKey | null {
  if (incoming === true) return "component.ActivityRowActions.contactSent";
  if (incoming === false) return "component.ActivityRowActions.contactReceived";
  return null;
}
