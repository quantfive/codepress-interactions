# Optional React adapter

Browser initialization at the application client entry point is sufficient; this adapter only owns its lifecycle when a component boundary is useful.

```tsx
import { useMemo } from 'react';
import { useInteractions } from '@codepress/interactions-react';

function InteractionCapture() {
  const options = useMemo(() => ({
    projectKey: 'public-project-key',
    endpoint: 'https://interactions.example.com',
  }), []);
  useInteractions(options);
  return null;
}
```

Pass a memoized options object. The hook returns a ref to the current handle for optional `runAction`/diagnostics. Effect cleanup releases its browser SDK lease, including React Strict Mode setup/cleanup. Changing options stops the previous lease before configuring the next. No component/control annotations are needed for baseline capture. Refer to the browser package for privacy, attribution and delivery limits.
