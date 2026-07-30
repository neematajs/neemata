<script setup lang="ts">
const { data } = await useAsyncData('hello', () => $fetch('/api/hello'))
</script>

<template>
  <main>nuxt-dev-marker {{ data?.message }}</main>
</template>
