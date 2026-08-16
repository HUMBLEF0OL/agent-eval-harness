export function canEdit(isOwner: boolean, isActive: boolean): boolean {
  return isOwner || isActive;
}
