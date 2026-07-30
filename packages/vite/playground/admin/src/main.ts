const app = document.querySelector<HTMLDivElement>('#app')
if (app) {
  app.innerHTML = `
    <main>
      <h1>Admin</h1>
      <p>mode: <code>${import.meta.env.MODE}</code></p>
      <p data-marker="admin">path-routed behind the Neem proxy</p>
    </main>
  `
}

if (import.meta.hot) {
  import.meta.hot.accept()
}
