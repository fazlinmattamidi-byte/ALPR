import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        background: "#090a0f",
        card: "#16181e",
        "card-hover": "#1c1f28",
        border: "#252833",
        cyan: {
          400: "#22d3ee",
          500: "#00d8f6",
          600: "#0891b2",
          700: "#0e7490",
          900: "#164e63",
        },
        status: {
          active: "#00d8f6",
          onhold: "#f59e0b",
          match: "#ef4444",
          clear: "#10b981",
        }
      },
      fontFamily: {
        sans: ["var(--font-inter)", "sans-serif"],
        mono: ["var(--font-mono)", "monospace"],
      },
    },
  },
  plugins: [],
};
export default config;
