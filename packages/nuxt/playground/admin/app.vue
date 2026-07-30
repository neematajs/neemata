<template>
  <div>
    <h1>neem-nuxt playground: admin</h1>
    <p>tick: {{ tick }}</p>
    <button @click="tick++">tick</button>
  </div>
</template>

<script setup lang="ts">
const tick = ref(0)
</script>
