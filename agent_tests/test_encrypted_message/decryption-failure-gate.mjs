export function installLiveDecryptionFailureHandler(adapter, rejectExchange) {
  let liveExchangeStarted = false;
  adapter.onDecryptionFailure(() => {
    if (liveExchangeStarted) {
      rejectExchange(new Error("Matrix sender saw an undecryptable event"));
    }
  });
  return () => {
    liveExchangeStarted = true;
  };
}
