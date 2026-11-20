/** Calls made while a run is pending collapse into that run, ms after the first of them. A run that swallowed calls is followed by one more, so the last run is never earlier than ms after the last call. */
export function throttle(fn: () => void, ms = 100): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined
  let again = false
  const run = () => { timer = again ? setTimeout(run, ms) : undefined; again = false; fn() }
  return () => { if (timer) again = true; else timer = setTimeout(run, ms) }
}
