
const MediaDB = (function() {
  'use strict';
  const DB_NAME = 'CollectStoreMediaDB';
  const DB_VERSION = 1;
  const STORE_NAME = 'media';
  let dbInstance = null;
  function openDB() {
    if (dbInstance) {
      return Promise.resolve(dbInstance);
    }
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: 'key' });
          store.createIndex('type', 'type', { unique: false });
        }
      };
      request.onsuccess = (event) => {
        dbInstance = event.target.result;
        dbInstance.onclose = () => {
          dbInstance = null;
        };
        dbInstance.onversionchange = () => {
          dbInstance.close();
          dbInstance = null;
        };
        resolve(dbInstance);
      };
      request.onerror = (event) => {
        reject(event.target.error);
      };
    });
  }
  async function saveMedia(key, blob, type, fileName) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([STORE_NAME], 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const mediaRecord = {
        key: key,
        blob: blob,
        type: type,
        fileName: fileName,
        savedAt: Date.now()
      };
      const request = store.put(mediaRecord);
      request.onsuccess = () => {
        resolve();
      };
      request.onerror = (event) => {
        reject(event.target.error);
      };
    });
  }
  async function getMedia(key) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([STORE_NAME], 'readonly');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.get(key);
      request.onsuccess = (event) => {
        const result = event.target.result;
        if (result) {
          resolve({
            blob: result.blob,
            type: result.type,
            fileName: result.fileName
          });
        } else {
          resolve(null);
        }
      };
      request.onerror = (event) => {
        reject(event.target.error);
      };
    });
  }
  async function getMediaAsDataURL(key) {
    const media = await getMedia(key);
    if (!media || !media.blob) {
      return null;
    }
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('Failed to read blob as data URL'));
      reader.readAsDataURL(media.blob);
    });
  }
  async function deleteMedia(key) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([STORE_NAME], 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.delete(key);
      request.onsuccess = () => {
        resolve();
      };
      request.onerror = (event) => {
        reject(event.target.error);
      };
    });
  }
  async function getAllMediaInfo() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([STORE_NAME], 'readonly');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.getAll();
      request.onsuccess = (event) => {
        const results = event.target.result.map(item => ({
          key: item.key,
          type: item.type,
          fileName: item.fileName,
          savedAt: item.savedAt,
          size: item.blob ? item.blob.size : 0
        }));
        resolve(results);
      };
      request.onerror = (event) => {
        reject(event.target.error);
      };
    });
  }
  async function clearAllMedia() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([STORE_NAME], 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.clear();
      request.onsuccess = () => {
        resolve();
      };
      request.onerror = (event) => {
        reject(event.target.error);
      };
    });
  }
  function fileToBlob(file) {
    return Promise.resolve(new Blob([file], { type: file.type }));
  }
  function formatBytes(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }
  return {
    openDB,
    saveMedia,
    getMedia,
    getMediaAsDataURL,
    deleteMedia,
    getAllMediaInfo,
    clearAllMedia,
    fileToBlob,
    formatBytes
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = MediaDB;
}
