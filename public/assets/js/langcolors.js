// GitHub linguist colors for common languages; deterministic hashed color for the rest.
export const LANG_COLORS = {
  JavaScript: '#f1e05a', TypeScript: '#3178c6', Python: '#3572A5', HTML: '#e34c26', CSS: '#563d7c',
  Java: '#b07219', Dart: '#00B4AB', Go: '#00ADD8', Rust: '#dea584', C: '#555555', 'C++': '#f34b7d',
  'C#': '#178600', PHP: '#4F5D95', Ruby: '#701516', Shell: '#89e051', Kotlin: '#A97BFF', Swift: '#F05138',
  Vue: '#41b883', Dockerfile: '#384d54', SCSS: '#c6538c', Lua: '#000080', 'Jupyter Notebook': '#DA5B0B',
  Unknown: '#8b949e', Other: '#8b949e',
};

const cache = new Map();

/** langColor('Go') → '#00ADD8'; null/empty → Unknown grey; others → stable hsl from a string hash. */
export function langColor(name) {
  if (!name) return LANG_COLORS.Unknown;
  if (LANG_COLORS[name]) return LANG_COLORS[name];
  let c = cache.get(name);
  if (!c) {
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
    c = `hsl(${h % 360}, ${55 + (h % 20)}%, ${50 + ((h >> 8) % 12)}%)`;
    cache.set(name, c);
  }
  return c;
}

/** <span class="lang-dot"> with background color via CSSOM (CSP-safe). */
export function langDot(name) {
  const s = document.createElement('span');
  s.className = 'lang-dot';
  s.setAttribute('aria-hidden', 'true');
  s.style.backgroundColor = langColor(name);
  return s;
}
