/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: '#121212',
        card: '#1e1e1e',
        cardborder: '#2a2a2a',
        text: '#A8E6CF',
        up: '#26a69a',
        'up-bright': '#00e676',
        down: '#ef5350',
        'down-bright': '#ff5252',
        warn: '#ffb300',
        'warn-bg': '#3d2e00',
        gold: '#c9a227',
      },
    },
  },
  plugins: [],
};
