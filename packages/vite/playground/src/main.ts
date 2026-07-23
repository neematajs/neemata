import './style.css'

// Vite 8.0.11 does not apply user `define` replacements in dev serve mode
// (upstream regression, see vitejs/vite#22419 for the same broken chain);
// the guard keeps the page working in dev while still proving the config
// file reached the build through the neem-vite config loader.
const tag =
  typeof __CONFIG_TAG__ === 'undefined'
    ? 'unreplaced (vite dev serve)'
    : __CONFIG_TAG__

const app = document.querySelector<HTMLDivElement>('#app')
if (app) {
  app.innerHTML = `
    <main>
      <h1>Neem × Vite</h1>
      <p>mode: <code>${import.meta.env.MODE}</code></p>
      <p>config: <code>${tag}</code></p>
      <p data-marker="playground">served through the Neem proxy</p>
    </main>
  `
}

if (import.meta.hot) {
  import.meta.hot.accept()
}
