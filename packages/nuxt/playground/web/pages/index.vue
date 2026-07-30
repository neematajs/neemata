<template>
  <div>
    <p>api: {{ data?.message }}</p>
    <p>count: {{ count }}</p>
    <button @click="count++">inc</button>
    <NuxtLink to="/about">about</NuxtLink>
  </div>
</template>

<script setup lang="ts">
// Server-rendered data fetch: the message must appear in the raw SSR HTML.
const { data } = await useAsyncData('hello', () => $fetch('/api/hello'))
const count = ref(0)
</script>
