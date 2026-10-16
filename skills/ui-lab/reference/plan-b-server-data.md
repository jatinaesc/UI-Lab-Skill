# Plan B — pages whose data loads on the server

The runtime mocks the **browser's** network. A Next.js Server Component (an `async`
page or layout awaiting data), `getServerSideProps`, or a server action builds its data
before the browser sees anything, so the browser mock cannot touch it.

The runtime also mirrors the lab state into a **`uilab` cookie**, with the same text as
the URL: `<lab>[.<scenario>][,flags]`. Server code can read it, so the fix is one marked
block in the server data function and nothing else.

## Rules

- Add code in **one place**: the server function that returns the data. Never in
  components, and never by changing an existing line. Only *insert* a marked block.
- Mark every inserted block `// @uilab:begin` … `// @uilab:end`. `uilab uninstall` strips
  exactly these blocks and then restores the file from git.
- Put the generated data in a new file beside it named `<thing>.uilab.ts`.
- Then run both commands:
  `uilab protect <new .uilab.ts file>` (git-excludes it) and
  `uilab protect <edited file>` (hides the edit with skip-worktree).
- Finish with `uilab status`. Both files must show as safe.

## Server function (Next.js App Router)

```ts
// services/schedule.server.ts  (tracked → protected)
export async function getSlots(token: string): Promise<SlotsResponse> {
  // @uilab:begin
  if (process.env.NODE_ENV !== "production") {
    const spec = (await (await import("next/headers")).cookies()).get("uilab")?.value;
    if (spec) {
      const lab = (await import("./schedule.uilab")).labSlots(spec);
      if (lab) return lab;
    }
  }
  // @uilab:end
  const res = await fetch(`${API}/schedule/slots?token=${token}`);
  ...
}
```

```ts
// services/schedule.uilab.ts  (git-excluded)
import type { SlotsResponse } from "./schedule.server";

export function labSlots(spec: string): SlotsResponse | null {
  const [head, ...flags] = spec.split(",");
  const [lab, scenario = ""] = head.split(".");
  if (lab !== "booking") return null;          // another lab is active: stay real
  const f = Object.fromEntries(flags.map((x) => x.split("=")).map(([k, v]) => [k, v ?? true]));
  const n = f.empty ? 0 : Number(f.flood) || 5;
  return { dates: Array.from({ length: n }, (_, i) => ({ date: day(i), slots: ["10:00", "11:30"] })) };
}
```

Typing the return as the real response type means a schema change breaks the typecheck
instead of silently breaking the page.

`getServerSideProps`: same block, reading `ctx.req.cookies.uilab`.

## Client store (only if the browser mock cannot reach the data)

Seed the store or query cache once at the highest boundary, inside a marked block:

```tsx
// @uilab:begin
useEffect(() => {
  if (process.env.NODE_ENV === "production" || !document.cookie.includes("uilab=")) return;
  queryClient.setQueryData(["slots", id], labSlots());   // exactly what a real load stores
}, []);
// @uilab:end
```

Trap: never withhold data that gates rendering. Setting an auth token to `null` to stop
a fetch once removed a date picker, because the component only rendered it when a token
existed. Replace the data; don't starve the component.

## Writes

Server actions and server-side calls are **not** blocked by the browser runtime. A
Plan B lab must not let the page reach a real mutation. Either mock that server function
the same way, or tell the user plainly which buttons still hit the real backend.
