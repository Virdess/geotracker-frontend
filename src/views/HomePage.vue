<template>
  <ion-page>
    <ion-content :fullscreen="true">
      <!-- ЭКРАН 1: АВТОРИЗАЦИЯ -->
      <div v-if="currentScreen === 'login'" class="login-screen">
        <div class="card">
          <h1 class="title">Tracker App</h1>
          <p class="subtitle">Введите код для передачи или просмотра маршрута.</p>
          
          <input 
            v-model="trackingCode" 
            type="text" 
            placeholder="Например: USER-123" 
            class="input-field"
          >
          
          <button @click="startRealTracking" class="btn btn-primary">
            Отследить себя (GPS)
          </button>

          <button @click="startWatchTracking" class="btn btn-secondary">
            Отследить по коду
          </button>
          
          <div class="divider">или</div>
          
          <button @click="startDemoTracking" class="btn btn-danger">
            Режим Фантома (Демо)
          </button>

          <div v-if="errorMessage" class="error-msg">
            {{ errorMessage }}
          </div>
          <div class="hint">
            Код можно использовать для передачи другому устройству, чтобы оно начало отслеживать ваш маршрут.
          </div>
        </div>
      </div>

      <!-- ЭКРАН 2: КАРТА -->
      <div v-show="currentScreen === 'map'" class="map-wrapper">
        <div id="map" class="map-container"></div>

        <!-- UI Поверх карты -->
        <div class="header-ui">
          <button @click="stopTracking" class="back-btn">← Назад</button>
          <div class="status-badge">
            <span class="dot" :class="isDemoMode ? 'bg-red' : isWatcherMode ? 'bg-yellow' : 'bg-green'"></span>
            {{ isDemoMode ? 'Фантом' : isWatcherMode ? 'Просмотр по коду' : 'Реальный GPS' }}
          </div>
        </div>

        <!-- Панель информации -->
        <div class="info-panel">
          <div class="info-header">
            <div>
              <p class="label">Код для передачи</p>
              <p class="value">{{ trackingCode || (isDemoMode ? 'DEMO-001' : 'GUEST') }}</p>
            </div>
            <div style="text-align: right;">
              <p class="label">Скорость</p>
              <p class="value text-blue">{{ speed }} км/ч</p>
            </div>
          </div>
          <div v-if="!isWatcherMode && !isDemoMode" class="share-note">
            Поделитесь этим кодом, чтобы другие могли отслеживать вашу геолокацию.
          </div>
          <div v-if="isWatcherMode" class="watch-note">
            Вы отслеживаете пользователя по коду <strong>{{ trackingCode }}</strong>.
          </div>
        </div>
      </div>
    </ion-content>
  </ion-page>
</template>

<script setup>
import { ref, nextTick, onUnmounted, computed } from 'vue';
import { IonPage, IonContent } from '@ionic/vue';
import { Geolocation } from '@capacitor/geolocation';
import { Capacitor } from '@capacitor/core';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { io } from 'socket.io-client';

// Состояние
const currentScreen = ref('login');
const trackingCode = ref('');
const isDemoMode = ref(false);
const isWatcherMode = ref(false);
const errorMessage = ref('');
const speed = ref(0);
const routeCoordinates = ref([]);

// Переменные
let map = null;
let marker = null;
let watchId = null;
let socket = null;
let demoInterval = null; // Для очистки интервала
let mapLoaded = false;

const OPENFREEMAP_STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';
const SOCKET_URL = 'http://192.168.8.70:3000';

const getBrowserCurrentPosition = () => {
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: true,
      timeout: 20000,
      maximumAge: 1000,
    });
  });
};

const initMap = async (startLng = 0, startLat = 0, zoom = 2) => {
  if (map) {
    map.remove();
    map = null;
    marker = null;
    mapLoaded = false;
  }

  map = new maplibregl.Map({
    container: 'map',
    style: OPENFREEMAP_STYLE_URL,
    center: [startLng, startLat],
    zoom,
    pitch: 45,
    attributionControl: false,
  });

  const el = document.createElement('div');
  el.className = `custom-marker ${isDemoMode.value ? 'phantom-marker' : ''}`;

  marker = new maplibregl.Marker({ element: el })
    .setLngLat([startLng, startLat])
    .addTo(map);

  map.on('load', () => {
    mapLoaded = true;
    map.resize();
    setTimeout(() => map.resize(), 100);

    map.addSource('route', {
      type: 'geojson',
      data: {
        type: 'Feature',
        geometry: {
          type: 'LineString',
          coordinates: routeCoordinates.value,
        },
      },
    });

    map.addLayer({
      id: 'route-line',
      type: 'line',
      source: 'route',
      layout: {
        'line-join': 'round',
        'line-cap': 'round',
      },
      paint: {
        'line-color': isDemoMode.value ? '#ef4444' : '#3b82f6',
        'line-width': 5,
        'line-opacity': 0.8,
      },
    });

    if (routeCoordinates.value.length) {
      updateRouteSource();
    }
  });
};

const updateRouteSource = () => {
  if (!map || !mapLoaded) return;
  const source = map.getSource('route');
  if (!source) return;
  source.setData({
    type: 'Feature',
    geometry: {
      type: 'LineString',
      coordinates: routeCoordinates.value,
    },
  });
};

const updatePosition = (lng, lat) => {
  const newPos = [lng, lat];
  routeCoordinates.value.push(newPos);

  if (marker) {
    marker.setLngLat(newPos);
  }

  if (map) {
    map.panTo(newPos, { duration: 1000 });
    updateRouteSource();
  }
};

const connectSocket = () => {
  if (socket?.connected) {
    return;
  }

  socket = io(SOCKET_URL, {
    transports: ['websocket'],
  });

  socket.on('connect', () => {
    errorMessage.value = '';
  });

  socket.on('connect_error', (err) => {
    errorMessage.value = 'Не удалось подключиться к серверу отслеживания.';
    console.error('Socket connect_error:', err);
  });
};

const onServerLocationUpdated = (data) => {
  if (!data || data.code !== trackingCode.value) {
    return;
  }

  const lng = data.lng;
  const lat = data.lat;

  if (!routeCoordinates.value.length) {
    routeCoordinates.value = [[lng, lat]];
    if (!map) {
      initMap(lng, lat, 15);
    }
  }

  updatePosition(lng, lat);
  speed.value = data.speed ? Math.round(data.speed * 3.6) : speed.value;
};

const startRealTracking = async () => {
  errorMessage.value = '';

  if (!trackingCode.value) {
    trackingCode.value = `USER-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
  }

  try {
    if (Capacitor.isNativePlatform()) {
      let permission = await Geolocation.checkPermissions();
      if (permission.location !== 'granted') {
        permission = await Geolocation.requestPermissions();
      }
      if (permission.location !== 'granted') {
        errorMessage.value = 'Нет доступа к геолокации. Пожалуйста, разрешите доступ в настройках устройства.';
        return;
      }
    } else {
      if (!navigator.geolocation) {
        errorMessage.value = 'Ваш браузер не поддерживает GPS.';
        return;
      }
      if (window.isSecureContext === false) {
        errorMessage.value = 'GPS заблокирован браузером. Требуется безопасное соединение (HTTPS) или localhost.';
        return;
      }
    }

    const position = Capacitor.isNativePlatform()
      ? await Geolocation.getCurrentPosition()
      : await getBrowserCurrentPosition();

    isDemoMode.value = false;
    isWatcherMode.value = false;
    currentScreen.value = 'map';
    routeCoordinates.value = [[position.coords.longitude, position.coords.latitude]];
    speed.value = 0;

    await nextTick();
    await initMap(position.coords.longitude, position.coords.latitude, 15);
    connectSocket();

    if (Capacitor.isNativePlatform()) {
      watchId = await Geolocation.watchPosition({ enableHighAccuracy: true }, (pos, err) => {
        if (err) {
          console.warn('watchPosition error', err);
          return;
        }
        const curLng = pos.coords.longitude;
        const curLat = pos.coords.latitude;

        updatePosition(curLng, curLat);
        speed.value = pos.coords.speed ? Math.round(pos.coords.speed * 3.6) : 0;

        if (socket) {
          socket.emit('updateLocation', {
            code: trackingCode.value,
            lat: curLat,
            lng: curLng,
          });
        }
      });
    } else {
      watchId = navigator.geolocation.watchPosition(
        (pos) => {
          const curLng = pos.coords.longitude;
          const curLat = pos.coords.latitude;

          updatePosition(curLng, curLat);
          speed.value = pos.coords.speed ? Math.round(pos.coords.speed * 3.6) : 0;

          if (socket) {
            socket.emit('updateLocation', {
              code: trackingCode.value,
              lat: curLng,
              lng: curLat,
            });
          }
        },
        (err) => {
          console.warn('Browser watchPosition error', err);
        },
        { enableHighAccuracy: true, maximumAge: 1000, timeout: 20000 },
      );
    }
  } catch (e) {
    const message = e?.message || e;
    if (typeof message === 'string' && message.includes('User denied')) {
      errorMessage.value = 'Вы запретили доступ к геоданным в браузере.';
    } else {
      errorMessage.value = 'Ошибка доступа к GPS: ' + (message || 'неизвестная ошибка');
    }
  }
};

const startWatchTracking = async () => {
  if (!trackingCode.value) {
    errorMessage.value = 'Введите код для начала просмотра.';
    return;
  }

  errorMessage.value = '';
  isDemoMode.value = false;
  isWatcherMode.value = true;
  currentScreen.value = 'map';
  routeCoordinates.value = [];
  speed.value = 0;

  await nextTick();
  await initMap(0, 0, 2);
  connectSocket();

  if (socket) {
    socket.on('locationUpdated', onServerLocationUpdated);
    socket.emit('watchCode', { code: trackingCode.value });
  }
};

const startDemoTracking = async () => {
  if (!trackingCode.value) {
    errorMessage.value = 'Введите код для демо-режима';
    return;
  }

  errorMessage.value = '';
  isDemoMode.value = true;
  isWatcherMode.value = false;
  currentScreen.value = 'map';
  routeCoordinates.value = [[71.4305, 51.1282]];
  speed.value = 45;

  await nextTick();
  await initMap(71.4305, 51.1282, 15);

  if (demoInterval) {
    clearInterval(demoInterval);
  }

  demoInterval = setInterval(() => {
    const last = routeCoordinates.value[routeCoordinates.value.length - 1];
    const currentLng = last[0] + 0.0001;
    const currentLat = last[1] + 0.0001;
    updatePosition(currentLng, currentLat);
    speed.value = 45;
  }, 2000);
};

const stopTracking = () => {
  currentScreen.value = 'login';
  routeCoordinates.value = [];
  speed.value = 0;
  isDemoMode.value = false;
  isWatcherMode.value = false;

  if (watchId !== null && watchId !== undefined) {
    if (Capacitor.isNativePlatform()) {
      Geolocation.clearWatch({ id: watchId });
    } else {
      navigator.geolocation.clearWatch(watchId);
    }
    watchId = null;
  }

  if (demoInterval) {
    clearInterval(demoInterval);
    demoInterval = null;
  }

  if (socket) {
    socket.off('locationUpdated', onServerLocationUpdated);
    socket.off('connect_error');
    socket.off('connect');
    socket.off('disconnect');
    socket.disconnect();
    socket = null;
  }
};

onUnmounted(() => {
  stopTracking();
  if (map) {
    map.remove();
    map = null;
  }
});
</script>

<style scoped>
/* Стили адаптированы под Ionic без Tailwind для надежности */
.login-screen { height: 100%; display: flex; align-items: center; justify-content: center; background: #f3f4f6; padding: 20px; }
.card { background: white; padding: 30px; border-radius: 20px; box-shadow: 0 10px 25px rgba(0,0,0,0.1); width: 100%; max-width: 400px; text-align: center; }
.title { font-size: 24px; font-weight: bold; margin-bottom: 10px; color: #1f2937; }
.subtitle { font-size: 14px; color: #6b7280; margin-bottom: 20px; }
.input-field { width: 100%; padding: 12px; border: 1px solid #d1d5db; border-radius: 10px; margin-bottom: 15px; }
.btn { width: 100%; padding: 12px; border-radius: 10px; font-weight: bold; margin-bottom: 10px; }
.btn-primary { background: #2563eb; color: white; border: none; }
.btn-secondary { background: #f3f4f6; color: #111827; border: 1px solid #d1d5db; }
.btn-danger { background: #fef2f2; color: #dc2626; border: 1px solid #fecaca; }
.divider { margin: 15px 0; color: #9ca3af; font-size: 14px; }
.error-msg { margin-top: 10px; color: #dc2626; background: #fef2f2; padding: 10px; border-radius: 8px; font-size: 14px; }
.hint { margin-top: 10px; color: #6b7280; font-size: 13px; line-height: 1.4; }
.share-note, .watch-note { margin-top: 12px; font-size: 14px; color: #374151; }
.bg-yellow { background: #fbbf24; }

.map-wrapper { height: 100%; position: relative; }
.map-container { position: absolute; top: 0; bottom: 0; width: 100%; }

.header-ui { position: absolute; top: 0; left: 0; right: 0; padding: 20px; z-index: 10; display: flex; justify-content: space-between; pointer-events: none; }
.back-btn { pointer-events: auto; background: white; border: none; padding: 10px 15px; border-radius: 20px; font-weight: bold; box-shadow: 0 4px 6px rgba(0,0,0,0.1); }
.status-badge { pointer-events: auto; background: white; padding: 8px 15px; border-radius: 20px; font-size: 14px; font-weight: bold; display: flex; align-items: center; gap: 8px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); }
.dot { width: 10px; height: 10px; border-radius: 50%; }
.bg-red { background: #ef4444; }
.bg-green { background: #10b981; }

.info-panel { position: absolute; bottom: 30px; left: 20px; right: 20px; background: white; padding: 20px; border-radius: 20px; z-index: 10; box-shadow: 0 10px 25px rgba(0,0,0,0.1); }
.info-header { display: flex; justify-content: space-between; align-items: center; }
.label { font-size: 12px; color: #9ca3af; text-transform: uppercase; font-weight: bold; margin: 0; }
.value { font-size: 18px; font-weight: bold; color: #1f2937; margin: 5px 0 0 0; }
.text-blue { color: #2563eb; }

/* Глобальные стили для маркера карты */
:deep(.custom-marker) {
  width: 24px; height: 24px; background-color: #3b82f6; border: 3px solid white; border-radius: 50%; box-shadow: 0 0 10px rgba(0,0,0,0.3); transition: transform 0.2s linear;
}
:deep(.phantom-marker) { background-color: #ef4444; }
</style>
