// js/firebase-config.js
// ----------------------------------------------------------------------------
// IMPORTANT: Replace the firebaseConfig object below with the keys from your
// Firebase Console (Project Settings -> General -> Your apps -> SDK setup).
// ----------------------------------------------------------------------------

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, RecaptchaVerifier, signInWithPhoneNumber } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT_ID.firebaseapp.com",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_PROJECT_ID.appspot.com",
  messagingSenderId: "YOUR_MESSAGING_SENDER_ID",
  appId: "YOUR_APP_ID"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
auth.useDeviceLanguage(); // Ensures SMS is sent in the user's language

// Export Firebase methods for use in register.html
window.SUBAFirebase = {
  auth,
  RecaptchaVerifier,
  signInWithPhoneNumber
};
