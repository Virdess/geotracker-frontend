<template>
  <ion-page>
    <ion-content :fullscreen="true">
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
            Отслеживать себя (GPS)
          </button>

          <button @click="startWatchTracking" class="btn btn-secondary">
            Отслеживать по коду
          </button>

          <div class="divider">или</div>

          <button @click="startDemoTracking" class="btn btn-danger">
            Режим фантома (демо)
          </button>

          <div v-if="errorMessage" class="error-msg">
            {{ errorMessage }}
          </div>
          <div class="hint">
            Поделитесь кодом с другим устройством, чтобы оно увидело вашу геопозицию в реальном времени.
          </div>

          <div class="debug-panel">
            <div class="debug-title">Диагностика</div>
            <div class="debug-row">
              <span>Backend</span>
              <strong>{{ SOCKET_URL }}</strong>
            </div>
            <div class="debug-row">
              <span>Socket</span>
              <strong>{{ socketStatus }}</strong>
            </div>
            <div class="debug-row">
              <span>Ошибка</span>
              <strong>{{ socketError || '-' }}</strong>
            </div>
            <div class="debug-row">
              <span>Сборка</span>
              <strong>{{ buildInfo }}</strong>
            </div>
            <div class="debug-row">
              <span>HTTP</span>
              <strong>{{ backendCheckStatus }}</strong>
            </div>
            <button @click="testBackendHttp" class="debug-btn">
              Check backend
            </button>
          </div>
        </div>
      </div>

      <div v-show="currentScreen === 'map'" class="map-wrapper">
        <div id="map" class="map-container"></div>

        <div class="header-ui">
          <button @click="stopTracking" class="back-btn">Назад</button>
          <div class="status-badge">
            <span class="dot" :class="isDemoMode ? 'bg-red' : isWatcherMode ? 'bg-yellow' : 'bg-green'"></span>
            {{ isDemoMode ? 'Фантом' : isWatcherMode ? 'Просмотр по коду' : 'Реальный GPS' }}
          </div>
        </div>

        <div class="info-panel">
          <div class="info-header">
            <div>
              <p class="label">Код для передачи</p>
              <p class="value">{{ trackingCode || (isDemoMode ? 'DEMO-001' : 'GUEST') }}</p>
            </div>
            <div class="speed-block">
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
          <div class="debug-panel map-debug-panel">
            <div class="debug-title">Диагностика</div>
            <div class="debug-row">
              <span>Backend</span>
              <strong>{{ SOCKET_URL }}</strong>
            </div>
            <div class="debug-row">
              <span>Socket</span>
              <strong>{{ socketStatus }}</strong>
            </div>
            <div class="debug-row">
              <span>ID</span>
              <strong>{{ socketId || '-' }}</strong>
            </div>
            <div class="debug-row">
              <span>Транспорт</span>
              <strong>{{ socketTransport || '-' }}</strong>
            </div>
            <div class="debug-row">
              <span>Ошибка</span>
              <strong>{{ socketError || '-' }}</strong>
            </div>
            <div class="debug-row">
              <span>Событие</span>
              <strong>{{ lastSocketEvent }}</strong>
            </div>
            <div class="debug-row">
              <span>HTTP</span>
              <strong>{{ backendCheckStatus }}</strong>
            </div>
            <button @click="testBackendHttp" class="debug-btn">
              Check backend
            </button>
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

const currentScreen = ref('login');
const trackingCode = ref('');
const isDemoMode = ref(false);
const isWatcherMode = ref(false);
const errorMessage = ref('');
const speed = ref(0);
const routeCoordinates = ref([]);
const socketStatus = ref('не подключен');
const socketId = ref('');
const socketTransport = ref('');
const socketError = ref('');
const backendCheckStatus = ref('not checked');
const lastSocketEvent = ref('нет событий');

let map = null;
let marker = null;
let watchId = null;
let socket = null;
let demoInterval = null;
let mapLoaded = false;
let lastAcceptedLocation = null;
let lastEmittedAt = 0;
let markerAnimationFrame = null;
let displayedPosition = null;

const OPENFREEMAP_STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';
const SOCKET_URL = import.meta.env.VITE_SOCKET_URL
  ?? `${window.location.protocol}//${window.location.hostname}:3001`;
const buildInfo = computed(() => `${import.meta.env.MODE}${import.meta.env.PROD ? ' / prod' : ' / dev'}`);
const socketPollingUrl = computed(() => {
  const url = new URL('/socket.io/', SOCKET_URL);
  url.searchParams.set('EIO', '4');
  url.searchParams.set('transport', 'polling');
  url.searchParams.set('t', Date.now().toString());
  return url.toString();
});
const MIN_ACCURACY_METERS = 80;
const MIN_DISTANCE_METERS = 4;
const MAX_REASONABLE_SPEED_MPS = 70;
const MIN_EMIT_INTERVAL_MS = 1000;
const SMOOTHING_FACTOR = 0.35;

const normalizeCode = () => {
  trackingCode.value = trackingCode.value.trim().toUpperCase();
  return trackingCode.value;
};

const getBrowserCurrentPosition = () => {
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: true,
      timeout: 20000,
      maximumAge: 1000,
    });
  });
};

const toLocation = (coords) => ({
  lat: coords.latitude,
  lng: coords.longitude,
  accuracy: coords.accuracy ?? null,
  speed: coords.speed ?? null,
  timestamp: Date.now(),
});

const getDistanceMeters = (first, second) => {
  const radius = 6371000;
  const lat1 = first.lat * Math.PI / 180;
  const lat2 = second.lat * Math.PI / 180;
  const deltaLat = (second.lat - first.lat) * Math.PI / 180;
  const deltaLng = (second.lng - first.lng) * Math.PI / 180;
  const a = Math.sin(deltaLat / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLng / 2) ** 2;

  return radius * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

const smoothLocation = (location) => {
  if (!lastAcceptedLocation) {
    return location;
  }

  return {
    ...location,
    lat: lastAcceptedLocation.lat + (location.lat - lastAcceptedLocation.lat) * SMOOTHING_FACTOR,
    lng: lastAcceptedLocation.lng + (location.lng - lastAcceptedLocation.lng) * SMOOTHING_FACTOR,
  };
};

const shouldAcceptLocation = (location) => {
  if (!Number.isFinite(location.lat) || !Number.isFinite(location.lng)) {
    return false;
  }

  if (location.accuracy && location.accuracy > MIN_ACCURACY_METERS) {
    return false;
  }

  if (!lastAcceptedLocation) {
    return true;
  }

  const distance = getDistanceMeters(lastAcceptedLocation, location);
  const elapsedSeconds = Math.max((location.timestamp - lastAcceptedLocation.timestamp) / 1000, 0.001);

  if (distance < MIN_DISTANCE_METERS) {
    return false;
  }

  return distance / elapsedSeconds <= MAX_REASONABLE_SPEED_MPS;
};

const queueMarkerMove = (lng, lat) => {
  const target = [lng, lat];

  if (!displayedPosition) {
    displayedPosition = target;
  }

  if (markerAnimationFrame) {
    cancelAnimationFrame(markerAnimationFrame);
  }

  const start = displayedPosition;
  const startedAt = performance.now();
  const duration = 700;

  const animate = (now) => {
    const progress = Math.min((now - startedAt) / duration, 1);
    const eased = 1 - (1 - progress) ** 3;
    const current = [
      start[0] + (target[0] - start[0]) * eased,
      start[1] + (target[1] - start[1]) * eased,
    ];

    displayedPosition = current;
    marker?.setLngLat(current);

    if (progress < 1) {
      markerAnimationFrame = requestAnimationFrame(animate);
    } else {
      markerAnimationFrame = null;
    }
  };

  markerAnimationFrame = requestAnimationFrame(animate);
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
  const lastPos = routeCoordinates.value[routeCoordinates.value.length - 1];

  if (!lastPos || getDistanceMeters({ lng: lastPos[0], lat: lastPos[1] }, { lng, lat }) >= MIN_DISTANCE_METERS) {
    routeCoordinates.value.push(newPos);
  }

  if (marker) {
    queueMarkerMove(lng, lat);
  }

  if (map) {
    map.easeTo({ center: newPos, duration: 900, essential: true });
    updateRouteSource();
  }
};

const emitLocation = (location) => {
  if (!socket || !trackingCode.value) return;

  const now = Date.now();
  if (now - lastEmittedAt < MIN_EMIT_INTERVAL_MS) return;

  lastEmittedAt = now;
  socket.emit('updateLocation', {
    code: normalizeCode(),
    lat: location.lat,
    lng: location.lng,
    speed: location.speed,
    accuracy: location.accuracy,
    timestamp: location.timestamp,
  });
};

const testBackendHttp = async () => {
  backendCheckStatus.value = 'checking...';

  try {
    const response = await fetch(socketPollingUrl.value, {
      method: 'GET',
      cache: 'no-store',
    });
    const text = await response.text();
    const preview = text.slice(0, 36).replace(/\s+/g, ' ');
    backendCheckStatus.value = `${response.status} ${response.ok ? 'OK' : 'ERROR'} ${preview}`;
  } catch (error) {
    backendCheckStatus.value = `${error?.name || 'Error'}: ${error?.message || error}`;
  }
};

const initMap = async (startLng = 0, startLat = 0, zoom = 2) => {
  if (map) {
    map.remove();
    map = null;
    marker = null;
    mapLoaded = false;
  }

  displayedPosition = [startLng, startLat];
  map = new maplibregl.Map({
    container: 'map',
    style: OPENFREEMAP_STYLE_URL,
    center: displayedPosition,
    zoom,
    pitch: 45,
    attributionControl: false,
  });

  const el = document.createElement('div');
  el.className = `custom-marker ${isDemoMode.value ? 'phantom-marker' : ''}`;
  marker = new maplibregl.Marker({ element: el }).setLngLat(displayedPosition).addTo(map);

  map.on('load', () => {
    mapLoaded = true;
    map.resize();
    setTimeout(() => map?.resize(), 100);

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

    updateRouteSource();
  });
};

const connectSocket = () => {
  if (socket) {
    return socket;
  }

  socketStatus.value = 'подключение...';
  lastSocketEvent.value = new Date().toLocaleTimeString();

  socket = io(SOCKET_URL, {
    transports: ['websocket', 'polling'],
    tryAllTransports: true,
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    timeout: 10000,
  });

  socket.on('connect', () => {
    errorMessage.value = '';
    socketStatus.value = 'подключен';
    socketId.value = socket.id;
    socketTransport.value = socket.io.engine.transport.name;
    socketError.value = '';
    lastSocketEvent.value = new Date().toLocaleTimeString();

    socket.io.engine.on('upgrade', (transport) => {
      socketTransport.value = transport.name;
      lastSocketEvent.value = new Date().toLocaleTimeString();
    });
  });

  socket.on('disconnect', (reason) => {
    socketStatus.value = `отключен: ${reason}`;
    socketId.value = '';
    socketTransport.value = '';
    lastSocketEvent.value = new Date().toLocaleTimeString();
  });

  socket.on('connect_error', (err) => {
    socketStatus.value = 'ошибка подключения';
    socketId.value = '';
    socketTransport.value = '';
    socketError.value = err?.message || 'unknown error';
    lastSocketEvent.value = new Date().toLocaleTimeString();
    errorMessage.value = 'Не удалось подключиться к серверу отслеживания.';
    console.error('Socket connect_error:', err);
  });

  socket.on('trackingError', (data) => {
    lastSocketEvent.value = new Date().toLocaleTimeString();
    errorMessage.value = data?.message || 'Ошибка сервера отслеживания.';
  });

  return socket;
};

const onServerLocationUpdated = (data) => {
  lastSocketEvent.value = new Date().toLocaleTimeString();

  if (!data || data.code !== normalizeCode()) {
    return;
  }

  const lng = Number(data.lng);
  const lat = Number(data.lat);

  if (!Number.isFinite(lng) || !Number.isFinite(lat)) {
    return;
  }

  if (!routeCoordinates.value.length) {
    routeCoordinates.value = [[lng, lat]];
    if (!map) {
      initMap(lng, lat, 15);
    }
  }

  updatePosition(lng, lat);
  speed.value = data.speed ? Math.round(data.speed * 3.6) : speed.value;
};

const handleGpsPosition = (pos) => {
  const rawLocation = toLocation(pos.coords);

  if (!shouldAcceptLocation(rawLocation)) {
    return;
  }

  const location = smoothLocation(rawLocation);
  lastAcceptedLocation = location;

  updatePosition(location.lng, location.lat);
  speed.value = location.speed ? Math.round(location.speed * 3.6) : 0;
  emitLocation(location);
};

const ensureGeolocationAccess = async () => {
  if (Capacitor.isNativePlatform()) {
    let permission = await Geolocation.checkPermissions();
    if (permission.location !== 'granted') {
      permission = await Geolocation.requestPermissions();
    }

    if (permission.location !== 'granted') {
      errorMessage.value = 'Нет доступа к геолокации. Разрешите доступ в настройках устройства.';
      return false;
    }

    return true;
  }

  if (!navigator.geolocation) {
    errorMessage.value = 'Ваш браузер не поддерживает GPS.';
    return false;
  }

  if (window.isSecureContext === false) {
    errorMessage.value = 'GPS заблокирован браузером. Нужен HTTPS или localhost.';
    return false;
  }

  return true;
};

const startRealTracking = async () => {
  errorMessage.value = '';
  normalizeCode();

  if (!trackingCode.value) {
    trackingCode.value = `USER-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
  }

  try {
    if (!await ensureGeolocationAccess()) {
      return;
    }

    const position = Capacitor.isNativePlatform()
      ? await Geolocation.getCurrentPosition({ enableHighAccuracy: true, timeout: 20000, maximumAge: 500 })
      : await getBrowserCurrentPosition();
    const initialLocation = toLocation(position.coords);

    isDemoMode.value = false;
    isWatcherMode.value = false;
    currentScreen.value = 'map';
    lastAcceptedLocation = initialLocation;
    lastEmittedAt = 0;
    routeCoordinates.value = [[initialLocation.lng, initialLocation.lat]];
    speed.value = 0;

    await nextTick();
    await initMap(initialLocation.lng, initialLocation.lat, 15);
    connectSocket();
    emitLocation(initialLocation);

    if (Capacitor.isNativePlatform()) {
      watchId = await Geolocation.watchPosition({
        enableHighAccuracy: true,
        timeout: 20000,
        maximumAge: 500,
      }, (pos, err) => {
        if (err) {
          console.warn('watchPosition error', err);
          return;
        }
        handleGpsPosition(pos);
      });
    } else {
      watchId = navigator.geolocation.watchPosition(
        handleGpsPosition,
        (err) => {
          console.warn('Browser watchPosition error', err);
        },
        { enableHighAccuracy: true, maximumAge: 500, timeout: 20000 },
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
  normalizeCode();

  if (!trackingCode.value) {
    errorMessage.value = 'Введите код для начала просмотра.';
    return;
  }

  errorMessage.value = '';
  isDemoMode.value = false;
  isWatcherMode.value = true;
  currentScreen.value = 'map';
  routeCoordinates.value = [];
  lastAcceptedLocation = null;
  speed.value = 0;

  await nextTick();
  await initMap(0, 0, 2);
  const activeSocket = connectSocket();

  activeSocket.off('locationUpdated', onServerLocationUpdated);
  activeSocket.on('locationUpdated', onServerLocationUpdated);
  activeSocket.emit('watchCode', { code: normalizeCode() });
  activeSocket.on('connect', () => {
    activeSocket.emit('watchCode', { code: normalizeCode() });
  });
};

const startDemoTracking = async () => {
  normalizeCode();

  if (!trackingCode.value) {
    errorMessage.value = 'Введите код для демо-режима';
    return;
  }

  errorMessage.value = '';
  isDemoMode.value = true;
  isWatcherMode.value = false;
  currentScreen.value = 'map';
  routeCoordinates.value = [[71.4305, 51.1282]];
  lastAcceptedLocation = { lng: 71.4305, lat: 51.1282, timestamp: Date.now() };
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
  lastAcceptedLocation = null;
  lastEmittedAt = 0;

  if (markerAnimationFrame) {
    cancelAnimationFrame(markerAnimationFrame);
    markerAnimationFrame = null;
  }

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
    socket.off('trackingError');
    socket.disconnect();
    socket = null;
  }

  socketStatus.value = 'не подключен';
  socketId.value = '';
  socketTransport.value = '';
  socketError.value = '';
  lastSocketEvent.value = 'нет событий';
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
.debug-panel { margin-top: 16px; padding: 12px; background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 10px; text-align: left; }
.debug-title { color: #374151; font-size: 12px; font-weight: 700; margin-bottom: 8px; text-transform: uppercase; }
.debug-row { display: flex; justify-content: space-between; gap: 12px; color: #6b7280; font-size: 12px; line-height: 1.4; }
.debug-row strong { color: #111827; font-weight: 600; text-align: right; overflow-wrap: anywhere; }
.debug-btn { width: 100%; margin-top: 10px; padding: 8px 10px; border: 1px solid #d1d5db; border-radius: 8px; background: white; color: #111827; font-size: 12px; font-weight: 700; }
.map-debug-panel { margin-top: 12px; }

.map-wrapper { height: 100%; position: relative; }
.map-container { position: absolute; top: 0; bottom: 0; width: 100%; }

.header-ui { position: absolute; top: 0; left: 0; right: 0; padding: 20px; z-index: 10; display: flex; justify-content: space-between; pointer-events: none; }
.back-btn { pointer-events: auto; background: white; border: none; padding: 10px 15px; border-radius: 20px; font-weight: bold; box-shadow: 0 4px 6px rgba(0,0,0,0.1); }
.status-badge { pointer-events: auto; background: white; padding: 8px 15px; border-radius: 20px; font-size: 14px; font-weight: bold; display: flex; align-items: center; gap: 8px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); }
.dot { width: 10px; height: 10px; border-radius: 50%; }
.bg-red { background: #ef4444; }
.bg-green { background: #10b981; }

.info-panel { position: absolute; bottom: 30px; left: 20px; right: 20px; background: white; padding: 20px; border-radius: 20px; z-index: 10; box-shadow: 0 10px 25px rgba(0,0,0,0.1); }
.info-header { display: flex; justify-content: space-between; align-items: center; gap: 16px; }
.speed-block { text-align: right; }
.label { font-size: 12px; color: #9ca3af; text-transform: uppercase; font-weight: bold; margin: 0; }
.value { font-size: 18px; font-weight: bold; color: #1f2937; margin: 5px 0 0 0; overflow-wrap: anywhere; }
.text-blue { color: #2563eb; }

:deep(.custom-marker) {
  width: 24px; height: 24px; background-color: #3b82f6; border: 3px solid white; border-radius: 50%; box-shadow: 0 0 10px rgba(0,0,0,0.3); transition: transform 0.2s linear;
}
:deep(.phantom-marker) { background-color: #ef4444; }
</style>
