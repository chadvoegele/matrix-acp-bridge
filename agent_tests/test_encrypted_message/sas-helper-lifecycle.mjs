// Ignored aliases and stale terminal requests are not successful SAS attempts.
// Only the handler's explicit protocol-completion result may stop the helper.
export async function dispatchSasAttempt(request, handle, verified, failed) {
  try {
    if ((await handle(request)) === true) verified();
  } catch {
    failed();
  }
}
