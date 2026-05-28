<template>
  <ion-page>
    <ion-content :fullscreen="true">
      <!-- ЭКРАН 1: АВТОРИЗАЦИЯ -->
      <div v-if="currentScreen === 'login'" class="login-screen">
        <div class="card">
          <h1 class="title">Tracker App</h1>
          <p class="subtitle">Введите код для отслеживания маршрута.</p>
          
          <input 
            v-model="trackingCode" 
            type="text" 
            placeholder="Например: USER-123" 
            class="input-field"
          >
          
          <button @click="startRealTracking" class="btn btn-primary">
            Отследить себя (GPS)
          </button>
          
          <div class="divider">или</div>
          
          <button @click="startDemoTracking" class="btn btn-danger">
            Режим Фантома (Демо)
          </button>

          <div v-if="errorMessage" class="error-msg">
            {{ errorMessage }}
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
            <span class="dot" :class="isDemoMode ? 'bg-red' : 'bg-green'"></span>
            {{ isDemoMode ? 'Фантом' : 'Реальный GPS' }}
          </div>
        </div>

        <!-- Панель информации -->
        <div class="info-panel">
          <div class="info-header">
            <div>
              <p class="label">Объект</p>
              <p class="value">{{ trackingCode || (isDemoMode ? 'Курьер #884' : 'Мое устройство') }}</p>
            </div>
            <div style="text-align: right;">
              <p class="label">Скорость</p>
              <p class="value text-blue">{{ speed }} км/ч</p>
            </div>
          </div>
        </div>
      </div>
    </ion-content>
  </ion-page>
</template>

<script setup>
import { ref, nextTick, onUnmounted } from 'vue';
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
const errorMessage = ref('');
const speed = ref(0);
const routeCoordinates = ref([]);

// Переменные
let map = null;
let marker = null;
let watchId = null;
let socket = null;
let demoInterval = null; // Для очистки интервала

// --- ИНИЦИАЛИЗАЦИЯ КАРТЫ ---
const initMap = async (startLng, startLat) => {
  if (map) map.remove();

  map = new maplibregl.Map({
    container: 'map',
    style: '[https://tiles.openfreemap.org/styles/liberty](https://tiles.openfreemap.org/styles/liberty)',
    center: [startLng, startLat],
    zoom: 15,
    pitch: 45,
    attributionControl: false
  });

  const el = document.createElement('div');
  el.className = `custom-marker ${isDemoMode.value ? 'phantom-marker' : ''}`;
  
  marker = new maplibregl.Marker({ element: el })
    .setLngLat([startLng, startLat])
    .addTo(map);

  map.on('load', () => {
    map.addSource('route', {
      type: 'geojson',
      data: { type: 'Feature', geometry: { type: 'LineString', coordinates: routeCoordinates.value } }
    });

    map.addLayer({
      id: 'route-line',
      type: 'line',
      source: 'route',
      paint: {
        'line-color': isDemoMode.value ? '#ef4444' : '#3b82f6',
        'line-width': 5,
        'line-opacity': 0.8
      }
    });
  });
};

const updatePosition = (lng, lat) => {
  const newPos = [lng, lat];
  routeCoordinates.value.push(newPos);
  
  if (marker) marker.setLngLat(newPos);
  if (map) {
    map.panTo(newPos, { duration: 1000 });
    const source = map.getSource('route');
    if (source) {
      source.setData({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: routeCoordinates.value }
      });
    }
  }
};

// --- ПОДКЛЮЧЕНИЕ К БЭКЕНДУ (NESTJS) ---
const connectSocket = () => {
  // Укажите IP вашего бэкенда. Если тестируете с телефона по Wi-Fi, пишите локальный IP (напр. [http://192.168.](http://192.168.)x.x:3000)
  socket = io('http://192.168.8.70:3000'); 
};

// --- РЕАЛЬНЫЙ GPS (Capacitor) ---
const startRealTracking = async () => {
  errorMessage.value = '';
  try {
    // 1. Умная проверка прав (Нативные приложения vs Браузер)
    if (Capacitor.isNativePlatform()) {
      // Если это iOS/Android приложение, запрашиваем права через Capacitor
      let permission = await Geolocation.checkPermissions();
      if (permission.location !== 'granted') {
        permission = await Geolocation.requestPermissions();
      }
      if (permission.location !== 'granted') {
        errorMessage.value = 'Нет доступа к геолокации. Пожалуйста, разрешите доступ в настройках устройства.';
        return;
      }
    } else {
      // Если это браузер (веб-версия или тестирование через IP)
      // В браузере проверка checkPermissions() может вызывать "Not implemented",
      // поэтому мы просто проверяем поддержку и безопасный контекст
      if (!navigator.geolocation) {
        errorMessage.value = 'Ваш браузер не поддерживает GPS.';
        return;
      }
      // Мобильные браузеры жестко требуют HTTPS для GPS (исключение - localhost)
      if (window.isSecureContext === false) {
        errorMessage.value = 'GPS заблокирован браузером. Требуется безопасное соединение (HTTPS) или localhost.';
        return;
      }
    }

    // 2. Получаем первоначальную точку (В браузере именно тут появится всплывающее окно "Разрешить доступ к геоданным")
    const position = await Geolocation.getCurrentPosition();
    
    isDemoMode.value = false;
    currentScreen.value = 'map';
    
    const lng = position.coords.longitude;
    const lat = position.coords.latitude;
    routeCoordinates.value = [[lng, lat]];
    
    await nextTick();
    await initMap(lng, lat);
    connectSocket();

    // 3. Отслеживаем перемещение в фоне. Сохраняем watchId для очистки
    watchId = await Geolocation.watchPosition({ enableHighAccuracy: true }, (pos, err) => {
      if (err) return;
      const curLng = pos.coords.longitude;
      const curLat = pos.coords.latitude;
      
      updatePosition(curLng, curLat);
      speed.value = pos.coords.speed ? Math.round(pos.coords.speed * 3.6) : 0;

      // Отправляем данные на наш NestJS бэкенд
      if (socket) {
        socket.emit('updateLocation', {
          code: trackingCode.value || 'GUEST',
          lat: curLat,
          lng: curLng
        });
      }
    });
  } catch (e) {
    // Делаем ошибки более читаемыми
    if (e.message.includes('User denied')) {
      errorMessage.value = 'Вы запретили доступ к геоданным в браузере.';
    } else {
      errorMessage.value = 'Ошибка доступа к GPS: ' + e.message;
    }
  }
};

// --- ДЕМО РЕЖИМ (ФАНТОМ) ---
const startDemoTracking = async () => {
  if (!trackingCode.value) {
    errorMessage.value = 'Введите код для демо-режима';
    return;
  }
  
  errorMessage.value = '';
  isDemoMode.value = true;
  currentScreen.value = 'map';
  connectSocket();

  // Имитация диспетчера: слушаем сокеты из бэкенда
  socket.emit('watchCode', { code: trackingCode.value });

  // В реальном проекте здесь мы бы слушали `socket.on('locationUpdated', ...)`
  let currentLng = 71.4305;
  let currentLat = 51.1282;
  routeCoordinates.value = [[currentLng, currentLat]];
  
  await nextTick();
  await initMap(currentLng, currentLat);

  // Очищаем предыдущий интервал, если он почему-то завис
  if (demoInterval) clearInterval(demoInterval);

  demoInterval = setInterval(() => {
    currentLng += 0.0001;
    currentLat += 0.0001;
    updatePosition(currentLng, currentLat);
    speed.value = 45;
  }, 2000);
};

// --- ОЧИСТКА ПАМЯТИ И ОСТАНОВКА ---
const stopTracking = () => {
  currentScreen.value = 'login';
  routeCoordinates.value = [];
  
  // Отписываемся от GPS трекера
  if (watchId) {
    Geolocation.clearWatch({ id: watchId });
    watchId = null;
  }
  
  // Очищаем интервал фантомного движения
  if (demoInterval) {
    clearInterval(demoInterval);
    demoInterval = null;
  }
  
  // Отключаем веб-сокеты
  if (socket) {
    socket.disconnect();
    socket = null;
  }
};

// Хук жизненного цикла Vue: когда компонент удаляется (например, переход на другой экран)
onUnmounted(() => {
  stopTracking();
  if (map) {
    map.remove();
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
.btn-danger { background: #fef2f2; color: #dc2626; border: 1px solid #fecaca; }
.divider { margin: 15px 0; color: #9ca3af; font-size: 14px; }
.error-msg { margin-top: 10px; color: #dc2626; background: #fef2f2; padding: 10px; border-radius: 8px; font-size: 14px; }

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
