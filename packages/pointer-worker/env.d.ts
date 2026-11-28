/// <reference types="@cloudflare/workers-types" />

declare global {
  interface Env {
    POINTER_API_KEY_SHA256?: string;
  }
}

export {};
