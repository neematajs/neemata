<script setup lang="ts">
const { data } = await useAsyncData('integration-hello', () =>
  $fetch('/api/hello'),
)
</script>

<template>
  <main>neem-web-marker {{ data?.message }}</main>
</template>
