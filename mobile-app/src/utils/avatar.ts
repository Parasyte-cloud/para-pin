export function initials(name: string): string {
  return (
    name
      .split(' ')
      .filter(Boolean)
      .slice(0, 2)
      .map((p) => p[0]?.toUpperCase())
      .join('') || '?'
  );
}

// Deterministic-ish color from a string, same idea as index.html's
// colorFor() helper — just enough so avatars aren't all one flat color.
export function colorFromString(str: string, ice: string, fire: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) hash = str.charCodeAt(i) + ((hash << 5) - hash);
  return Math.abs(hash) % 2 === 0 ? ice : fire;
}
