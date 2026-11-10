export function hasBurstProgress(burst, recoveredBefore, recoveredNow, firstDelivered) {
  return recoveredNow > recoveredBefore || (burst > 0 && firstDelivered);
}
