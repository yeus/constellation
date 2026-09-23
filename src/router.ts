import { createRouter, createWebHistory } from 'vue-router'

import MapView from './views/MapView.vue'

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', component: MapView },
    { path: '/share', component: MapView },
  ],
})
