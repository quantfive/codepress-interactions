import { useEffect, useRef } from "react";
import {
  initInteractions,
  type InteractionHandle,
  type InteractionOptions,
} from "@codepress/interactions-browser";
export type {
  InteractionHandle,
  InteractionOptions,
} from "@codepress/interactions-browser";
/** Pass a memoized options object. Strict Mode setup/cleanup is safe. */
export function useInteractions(
  options: InteractionOptions,
): React.MutableRefObject<InteractionHandle | null> {
  const handle = useRef<InteractionHandle | null>(null);
  useEffect(() => {
    const lease = initInteractions(options);
    handle.current = lease;
    return () => {
      lease.shutdown();
      if (handle.current === lease) handle.current = null;
    };
  }, [options]);
  return handle;
}
