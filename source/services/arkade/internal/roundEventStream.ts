// A claim follows its round over one long-lived connection, and answers each
// round event with a nonce or a signature. The provider reopens that connection
// itself after a quiet timeout, but treats a connection the network cut as fatal:
// the claim ends there, nothing is sent for the round, and the batch fails for
// everyone in it. A cut is not a refusal, so the stream is opened again and the
// claim keeps listening.
//
// Only a connection that was up is reopened. One that never delivers an event
// fails exactly as before, which is also what ends this when the device is
// offline.

export type RoundEventStreamOptions = {
  signal?: AbortSignal;
  onReopen?: (error: unknown) => void;
};

export async function* reopenWhenCut<T>(
  open: () => AsyncIterable<T>,
  options: RoundEventStreamOptions = {},
): AsyncGenerator<T, void, undefined> {
  for (;;) {
    let received = 0;
    try {
      for await (const event of open()) {
        received += 1;
        yield event;
      }
      return;
    } catch (error: unknown) {
      if (options.signal?.aborted || received === 0) throw error;
      options.onReopen?.(error);
    }
  }
}
