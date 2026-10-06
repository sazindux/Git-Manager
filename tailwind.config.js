/** @type {import('tailwindcss').Config} */
// Primer-dark tokens (see :root in src/styles.css).
export default {
  content: ['./public/**/*.{html,js}'],
  theme: {
    extend: {
      colors: {
        canvas: { DEFAULT: '#0d1117', subtle: '#161b22', inset: '#010409' },
        border: { DEFAULT: '#30363d', muted: '#21262d' },
        fg: { DEFAULT: '#e6edf3', muted: '#8b949e', subtle: '#7d8590' },
        accent: { DEFAULT: '#2f81f7', link: '#58a6ff', emphasis: '#1f6feb' },
        success: { DEFAULT: '#3fb950', emphasis: '#238636' },
        danger: { DEFAULT: '#f85149', emphasis: '#da3633' },
        attention: '#d29922',
        done: '#a371f7',
      },
      fontFamily: {
        sans: ['-apple-system', 'BlinkMacSystemFont', '"Segoe UI"', '"Noto Sans"', 'Helvetica', 'Arial', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', '"SF Mono"', 'Menlo', 'Consolas', 'monospace'],
      },
      borderRadius: { md: '6px' },
    },
  },
  plugins: [],
};
