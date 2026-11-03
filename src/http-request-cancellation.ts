import type { ServerResponse } from "node:http";

/** Cancel upstream reads when the browser leaves before receiving a response. */
export function responseCancellation(response: ServerResponse): AbortSignal {
  const controller = new AbortController();
  const cleanup = (): void => {
    response.off("close", onClose);
    response.off("finish", cleanup);
  };
  const onClose = (): void => {
    cleanup();
    if (!response.writableFinished) controller.abort();
  };
  response.once("close", onClose);
  response.once("finish", cleanup);
  if (response.destroyed) onClose();
  return controller.signal;
}
