/* ─── Face authentication (face-api.js, pure frontend, no backend) ─────────
   - Register: capture a face descriptor once, store in localStorage.
   - Verify: capture from webcam, compare Euclidean distance to the stored
     descriptor; distance < 0.5 means the same person (higher = stricter).
   Models load from jsDelivr CDN (~1.5MB total, cached by browser after first).
────────────────────────────────────────────────────────────────────────── */
import * as faceapi from '@vladmandic/face-api';

const MODEL_URL = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.15/model/';
const STORE_KEY = 'aba.face.descriptor.v1';
const THRESHOLD = 0.5; // lower = stricter

let modelsLoaded = false;

export async function loadFaceModels(): Promise<boolean> {
  if (modelsLoaded) return true;
  if (typeof window === 'undefined') return false;
  try {
    await Promise.all([
      faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
      faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL),
      faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL),
    ]);
    modelsLoaded = true;
    return true;
  } catch {
    return false;
  }
}

export function isFaceRegistered(): boolean {
  try {
    return Boolean(localStorage.getItem(STORE_KEY));
  } catch {
    return false;
  }
}

export function clearFaceRegistration(): void {
  try { localStorage.removeItem(STORE_KEY); } catch { /* noop */ }
}

/** Capture a face descriptor from a video element. Returns null if no face. */
async function captureDescriptor(video: HTMLVideoElement): Promise<Float32Array | null> {
  const detection = await faceapi
    .detectSingleFace(video, new faceapi.TinyFaceDetectorOptions({ inputSize: 224, scoreThreshold: 0.5 }))
    .withFaceLandmarks()
    .withFaceDescriptor();
  return detection ? detection.descriptor : null;
}

/** Register the current face. Returns true on success. */
export async function registerFace(video: HTMLVideoElement): Promise<boolean> {
  if (!modelsLoaded) { const ok = await loadFaceModels(); if (!ok) return false; }
  try {
    const desc = await captureDescriptor(video);
    if (!desc) return false;
    localStorage.setItem(STORE_KEY, JSON.stringify(Array.from(desc)));
    return true;
  } catch {
    return false;
  }
}

/** Verify current face against the registered one. Returns match score (0..1, higher = better). */
export async function verifyFace(video: HTMLVideoElement): Promise<{ match: boolean; score: number }> {
  if (!modelsLoaded) { const ok = await loadFaceModels(); if (!ok) return { match: false, score: 0 }; }
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return { match: false, score: 0 };
    const stored = new Float32Array(JSON.parse(raw));
    const desc = await captureDescriptor(video);
    if (!desc) return { match: false, score: 0 };
    const distance = faceapi.euclideanDistance(stored, desc);
    const score = Math.max(0, 1 - distance); // 0..1
    return { match: distance < THRESHOLD, score };
  } catch {
    return { match: false, score: 0 };
  }
}

/** Start webcam stream. Returns the stream; caller attaches to <video>. */
export async function startCamera(): Promise<MediaStream | null> {
  try {
    return await navigator.mediaDevices.getUserMedia({
      video: { width: 320, height: 320, facingMode: 'user' },
      audio: false,
    });
  } catch {
    return null;
  }
}

export function stopCamera(stream: MediaStream | null): void {
  stream?.getTracks().forEach((t) => t.stop());
}
