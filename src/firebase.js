import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";

// Estas claves salen de tu propio proyecto gratis en https://console.firebase.google.com
// Se cargan desde el archivo .env (ver .env.example) — nunca las pegues acá directamente.
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

export const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);

// "Código de familia": todos los celulares que usen el mismo código
// leen y escriben el mismo documento, sin necesidad de login.
// Cambialo por algo propio antes de compartir el link con tu familia.
export const FAMILY_CODE = import.meta.env.VITE_FAMILY_CODE || "mi-familia";
