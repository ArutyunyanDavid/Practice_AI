import type { Config } from 'tailwindcss';

export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: '#17211b',
        sage: {
          50: '#f3f8f4',
          100: '#e3efe6',
          200: '#c5dec9',
          300: '#9bc3a3',
          400: '#6ca47a',
          500: '#4d875e',
          600: '#3b6c4a',
          700: '#31563e',
          800: '#294534',
          900: '#233a2d'
        },
        parchment: '#faf9f6'
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        display: ['Lora', 'Georgia', 'serif']
      },
      boxShadow: {
        soft: '0 18px 50px rgba(26, 48, 35, 0.08)',
        paper: '0 8px 30px rgba(26, 39, 31, 0.10)'
      }
    },
  },
  plugins: [],
} satisfies Config;
