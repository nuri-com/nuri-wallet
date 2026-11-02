// How an activity row names a saved contact. The direction decides the
// wording: money in is "From <name>", money out is "To <name>", so a row reads
// as a direction rather than as a verb that can be taken for the opposite
// action. A row that does not state its direction is never renamed, so a
// payment can never read the wrong way round.
export type ContactRowLabelKey =
  | "component.ActivityRowActions.contactFrom"
  | "component.ActivityRowActions.contactTo";

export function contactRowLabelKey(incoming: boolean | undefined): ContactRowLabelKey | null {
  if (incoming === true) return "component.ActivityRowActions.contactFrom";
  if (incoming === false) return "component.ActivityRowActions.contactTo";
  return null;
}
