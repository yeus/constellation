export const shouldSignalIdleAfterShareUpdate = (
  previousShareCount: number,
  currentShareCount: number,
): boolean => previousShareCount > 0 && currentShareCount === 0
